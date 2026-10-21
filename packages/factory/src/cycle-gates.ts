import { decideReview, executorsUsed, fixPrompt, fullResult, parseReview } from "@shoalwork/lead"
import { Clock, Effect } from "effect"
import { type Kit, SETTLED_LEAD } from "./cycle-core.js"
import type { Dispatch } from "./cycle-dispatch.js"
import type { Merge } from "./cycle-merge.js"
import { type CycleState, clearCiSignal, moveCycle } from "./cycle-rows.js"
import { e2ePrompt, fixNoteForCi, fixNoteForE2e, reviewPrompt } from "./cycle-text.js"
import { type ProjectView, stateOf, type TaskRow } from "./kanban-rows.js"
import { repoOf } from "./sync-github.js"

export type ChecksVerdict = "pass" | "fail" | "pending" | "unknown"

// The gates of the cycle (T-061): the pull request's checks, the testpilot and the reviewer. Each gate hands over to
// the next Bot (the child already handed over is reused, so a repeated pass never creates a second one) and a gate
// that fails sends one fix back to the worker.
export const makeGates = (kit: Kit, dispatch: Dispatch, merge: Merge) => {
  const { deps, leadId, move, block, orBlock, handTo } = kit
  const { sql, beacon, lead, gh } = deps

  // The reviewer runs on an executor no worker run of this task used (T-051); with no worker record there is nothing to exclude.
  const enterReview = (project: ProjectView, task: TaskRow, cycle: CycleState, from: "ci" | "e2e") =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null) return
      const exclude = yield* executorsUsed(beacon, yield* Effect.forEach(cycle.workerTasks, leadId))
      if (exclude.length === 0)
        return yield* block(
          project.slug,
          task,
          "no worker executor on record to exclude from the review",
          cycle.currentTaskId,
        )
      const child = yield* handTo(project.slug, cycle.currentTaskId, "reviewer", task.id, {
        title: `Review: ${task.title}`.slice(0, 200),
        prompt: reviewPrompt(task.title, task.pr_number),
        kind: "code",
        repo: { url: project.repoUrl, base: task.branch ?? project.defaultBranch },
        acceptance: [],
        review: { excludeExecutors: exclude },
      })
      if (child === undefined)
        return yield* block(project.slug, task, "message limit on the task", cycle.currentTaskId)
      const at = yield* Clock.currentTimeMillis
      const next = {
        ...cycle,
        phase: "review",
        currentTaskId: child.id,
        ciSignal: null,
        sinceMs: at,
      } as const
      if (!(yield* moveCycle(sql, [from], next))) return
      if (from === "ci" && stateOf(task.state) === "in_review")
        yield* move(project.slug, task.id, "testing", "ci green")
    }).pipe(orBlock(project.slug, task, "review handoff"))

  // The checks are green: the testpilot runs the project's end-to-end commands, or the reviewer follows at once.
  const afterCi = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null) return
      if (project.e2e.length === 0) return yield* enterReview(project, task, cycle, "ci")
      const child = yield* handTo(project.slug, cycle.currentTaskId, "testpilot", task.id, {
        title: `E2E: ${task.title}`.slice(0, 200),
        prompt: e2ePrompt(task.title, task.pr_number),
        kind: "routine",
        repo: { url: project.repoUrl, base: task.branch ?? project.defaultBranch },
        acceptance: [...project.e2e],
      })
      if (child === undefined)
        return yield* block(project.slug, task, "message limit on the task", cycle.currentTaskId)
      const at = yield* Clock.currentTimeMillis
      const next = { ...cycle, phase: "e2e", currentTaskId: child.id, ciSignal: null, sinceMs: at } as const
      if (!(yield* moveCycle(sql, ["ci"], next))) return
      if (stateOf(task.state) === "in_review") yield* move(project.slug, task.id, "testing", "ci green")
    }).pipe(orBlock(project.slug, task, "e2e handoff"))

  // The result of a CI event is a hint, not a verdict: it may belong to an older push, or to one workflow of several.
  // The checks of the pull request (all of them, as they are now) decide. Pending clears the hint; the next event or
  // the observer's poll asks again. A gh failure leaves everything as it was.
  const confirmCi = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (task.pr_number === null) return "unknown" as const
      const verdict: ChecksVerdict = yield* gh
        .prChecks(repoOf(project.repoUrl) ?? project.repoUrl, task.pr_number, {
          watch: false,
          timeoutMs: 60_000,
        })
        .pipe(Effect.catch(() => Effect.succeed("unknown" as const)))
      if (verdict === "pass") yield* afterCi(project, task, cycle)
      else if (verdict === "fail")
        yield* dispatch.failed(project, task, cycle, "ci", fixNoteForCi(task.branch, task.pr_number), "ci")
      else if (verdict === "pending")
        yield* clearCiSignal(sql, project.slug, task.id, yield* Clock.currentTimeMillis)
      return verdict
    })

  const afterE2e = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null) return
      const got = yield* lead.get(yield* leadId(cycle.currentTaskId))
      if (!SETTLED_LEAD.has(got.state)) return
      if (got.state === "done" && (got.verdict === undefined || got.verdict.kind === "ok"))
        return yield* enterReview(project, task, cycle, "e2e")
      yield* dispatch.failed(project, task, cycle, "e2e", fixNoteForE2e(task.pr_number), "end-to-end checks")
    })

  const afterReview = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null) return
      const id = yield* leadId(cycle.currentTaskId)
      const got = yield* lead.get(id)
      if (!SETTLED_LEAD.has(got.state)) return
      if (got.state !== "done")
        return yield* block(project.slug, task, `review task ${got.state}`, cycle.currentTaskId)
      const answer = (yield* fullResult(beacon, id)) ?? got.verdict?.summary ?? ""
      const decision = decideReview(parseReview(answer), cycle.fixes + 1)
      if (decision._tag === "accept") {
        const next = { ...cycle, phase: "merge", sinceMs: yield* Clock.currentTimeMillis } as const
        if (!(yield* moveCycle(sql, ["review"], next))) return
        if (stateOf(task.state) === "testing")
          yield* move(project.slug, task.id, "merging", "review accepted")
        return yield* merge.mergeStart(project, task, next)
      }
      if (decision._tag === "fix") {
        const prompt = fixPrompt(
          `Fix the pull request${task.pr_number === null ? "" : ` #${task.pr_number}`}.`,
          decision.findings,
        )
        return yield* dispatch.failed(project, task, cycle, "review", prompt.slice(0, 4000), "review")
      }
      yield* block(project.slug, task, `review: ${decision._tag}`, cycle.currentTaskId)
    })

  return { confirmCi, afterE2e, afterReview }
}
