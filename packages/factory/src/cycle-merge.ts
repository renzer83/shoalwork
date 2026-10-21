import { ApprovalId, type ToolCall } from "@shoalwork/contracts"
import { Clock, Effect, Schema } from "effect"
import type { Kit } from "./cycle-core.js"
import { type CycleState, moveCycle } from "./cycle-rows.js"
import { MERGE_WAIT_MS } from "./cycle-text.js"
import type { ProjectView, TaskRow } from "./kanban-rows.js"
import { repoOf } from "./sync-github.js"

const CHECKS_POLL_MS = 60_000

// The merge side of the cycle (T-061): the policy decides whether the pull request is merged now, after a person says
// yes, or never; then the cycle waits for GitHub to finish it.
export const makeMerge = (kit: Kit) => {
  const { deps, leadId, move, block, orBlock } = kit
  const { sql, lead, gh } = deps

  const mergeCall = (pr: number): ToolCall => ({
    tool: "Bash",
    input: { command: `gh pr merge ${pr} --squash` },
  })

  const mergeNow = (project: ProjectView, task: TaskRow, cycle: CycleState, from: CycleState["phase"]) =>
    Effect.gen(function* () {
      // Fail-closed: no pull request number, no merge.
      if (task.pr_number === null)
        return yield* block(project.slug, task, "nothing to merge", cycle.currentTaskId ?? undefined)
      const at = yield* Clock.currentTimeMillis
      if (!(yield* moveCycle(sql, [from], { ...cycle, phase: "merged", sinceMs: at, checkedMs: null })))
        return
      const merged = yield* gh
        .prMerge(repoOf(project.repoUrl) ?? project.repoUrl, task.pr_number, {
          squash: true,
          auto: true,
          deleteBranch: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
      if (!merged)
        return yield* block(project.slug, task, "the merge failed", cycle.currentTaskId ?? undefined)
    })

  // Merge by policy: allowed + autoMerge merges; anything else asks a person; a deny or a missing policy blocks. The
  // policy is asked as the Bot that opened the pull request (the last worker of the task): the reviewer only reads and
  // comments, so its rules say nothing about who may merge.
  const mergeStart = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      const workerTask = cycle.workerTasks.at(-1)
      if (cycle.currentTaskId === null || task.pr_number === null || workerTask === undefined) {
        return yield* block(project.slug, task, "nothing to merge", cycle.currentTaskId ?? undefined)
      }
      const workerTaskId = yield* leadId(workerTask)
      const worker = (yield* lead.get(workerTaskId)).spec.botId
      const call = mergeCall(task.pr_number)
      const decision = deps.policy === undefined ? undefined : yield* deps.policy.evaluate(worker, call)
      if (decision === undefined || decision.effect === "deny") {
        return yield* block(project.slug, task, "merge refused by policy", cycle.currentTaskId)
      }
      if (decision.effect === "allow" && project.autoMerge)
        return yield* mergeNow(project, task, cycle, "merge")
      if (deps.approvals === undefined)
        return yield* block(
          project.slug,
          task,
          "merge needs approval and there is no approval flow",
          cycle.currentTaskId,
        )
      const request = yield* deps.approvals.request({
        taskId: workerTaskId,
        botId: worker,
        action: call,
        risk: decision.risk,
        mode: "inline",
      })
      yield* moveCycle(sql, ["merge"], { ...cycle, phase: "merge_wait", approvalId: request.id })
    }).pipe(orBlock(project.slug, task, "merge"))

  const afterApproval = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (deps.approvals === undefined || cycle.approvalId === null) return
      const approval = yield* deps.approvals.get(
        yield* Schema.decodeUnknownEffect(ApprovalId)(cycle.approvalId).pipe(Effect.orDie),
      )
      if (approval.status === "pending") return
      if (approval.status !== "approved")
        return yield* block(project.slug, task, `merge ${approval.status}`, cycle.currentTaskId ?? undefined)
      if (!(yield* deps.approvals.consume(approval.id)))
        return yield* block(
          project.slug,
          task,
          "merge approval already used",
          cycle.currentTaskId ?? undefined,
        )
      yield* mergeNow(project, task, cycle, "merge_wait")
    }).pipe(orBlock(project.slug, task, "merge approval"))

  // The merge was asked (auto): the webhook finishes the task; without it, the pull request itself is asked. A pull
  // request closed without a merge, or one still open past the limit (the auto-merge never completed), blocks it.
  const afterMerged = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (task.pr_number === null) return
      const at = yield* Clock.currentTimeMillis
      if (cycle.checkedMs === null || at - cycle.checkedMs >= CHECKS_POLL_MS) {
        yield* sql`UPDATE project_cycles SET checked_ms = ${at} WHERE project = ${project.slug} AND task_id = ${task.id}`
        const view = yield* gh
          .prView(repoOf(project.repoUrl) ?? project.repoUrl, task.pr_number)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (view?.state === "MERGED") {
          yield* move(project.slug, task.id, "done", "pr merged")
          return
        }
        if (view?.state === "CLOSED")
          return yield* block(
            project.slug,
            task,
            "the pull request was closed without a merge",
            cycle.currentTaskId ?? undefined,
          )
      }
      if (at - cycle.sinceMs >= MERGE_WAIT_MS)
        return yield* block(
          project.slug,
          task,
          "the merge did not complete in time",
          cycle.currentTaskId ?? undefined,
        )
    })

  return { mergeStart, afterApproval, afterMerged }
}

export type Merge = ReturnType<typeof makeMerge>
