import { TaskSpec } from "@shoalwork/contracts"
import { Clock, Effect, Option, Schema, Stream } from "effect"
import { type Kit, SETTLED_LEAD } from "./cycle-core.js"
import { type CycleState, moveCycle, startCycle } from "./cycle-rows.js"
import { MAX_FIXES, pullOf, workerPrompt } from "./cycle-text.js"
import { tasksOf } from "./kanban.js"
import { type ProjectView, stateOf, type TaskRow } from "./kanban-rows.js"
import { repoOf } from "./sync-github.js"

const decodeReceived = Schema.decodeUnknownOption(Schema.Struct({ task: TaskSpec }))

// The worker side of the cycle (T-061): a ready task becomes a worker task, a failed gate becomes one fix, and a
// finished worker becomes a pull request in review.
export const makeDispatch = (kit: Kit) => {
  const { deps, leadId, move, block, orBlock, handTo } = kit
  const { sql, kanban, lead, bots, gh, beacon } = deps

  // ready -> in_progress -> worker task. The board's WIP limit decides how many start; the rest wait.
  const dispatchWorker = (project: ProjectView, task: TaskRow) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const base = {
        project: project.slug,
        taskId: task.id,
        workerTasks: [],
        fixes: 0,
        ciSignal: null,
        sinceMs: at,
        checkedMs: null,
        approvalId: null,
        fixNote: null,
      } as const
      // The row exists before the Lead task, so a crash in between leaves a visible `work` cycle with no task (the
      // sweep adopts the task if the intake got through, or sends the board task back to `ready`).
      yield* startCycle(sql, { ...base, phase: "work", currentTaskId: null })
      const bot = yield* bots.getByName(`worker-${project.slug}`)
      const repo = repoOf(project.repoUrl)
      const issue =
        task.issue_number === null || repo === undefined
          ? undefined
          : yield* gh.issueView(repo, task.issue_number).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const spec = yield* lead.intake({
        botId: bot.id,
        title: (task.issue_number === null
          ? task.title
          : `Closes #${task.issue_number}: ${task.title}`
        ).slice(0, 200),
        prompt: workerPrompt(task.issue_number, issue?.title ?? task.title, issue?.body ?? ""),
        kind: "code",
        repo: {
          url: project.repoUrl,
          base: project.defaultBranch,
          ...(task.issue_number === null ? {} : { issue: task.issue_number }),
        },
        acceptance: [...project.gates],
        budget: bot.budget,
        origin: "api",
        correlationId: task.id,
      })
      yield* moveCycle(sql, ["work"], {
        ...base,
        phase: "work",
        currentTaskId: spec.id,
        workerTasks: [spec.id],
      })
    })

  // Starts every ready task the WIP limit allows. A task the dispatch cannot start is blocked, not retried forever,
  // and one task failing does not stop the next.
  const promote = (project: ProjectView) =>
    Effect.gen(function* () {
      if (project.status !== "active") return 0
      let started = 0
      for (const task of (yield* tasksOf(sql, project.slug)).filter(
        (row) => stateOf(row.state) === "ready",
      )) {
        const moved = yield* kanban
          .move({
            project: project.slug,
            taskId: task.id,
            to: "in_progress",
            reason: "scheduler",
            actor: "system",
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error._tag === "Conflict" || error._tag === "NotFound"
                ? Effect.succeed(false)
                : Effect.fail(error),
            ),
          )
        if (!moved) break
        started += 1
        yield* dispatchWorker(project, task).pipe(orBlock(project.slug, task, "worker dispatch"))
      }
      return started
    })

  const fixStart = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null)
        return yield* block(project.slug, task, "fix without a task to continue")
      // The fix is board work again: it waits for a WIP slot like any other.
      const state = stateOf(task.state)
      if (state !== "in_progress" && !(yield* move(project.slug, task.id, "in_progress", "fix"))) return
      const child = yield* handTo(project.slug, cycle.currentTaskId, "worker", task.id, {
        title: `Fix: ${task.title}`.slice(0, 200),
        prompt: `${cycle.fixNote ?? "Fix the problems found."}\n\n${workerPrompt(task.issue_number, task.title, "")}`,
        kind: "code",
        repo: {
          url: project.repoUrl,
          base: project.defaultBranch,
          ...(task.issue_number === null ? {} : { issue: task.issue_number }),
        },
        acceptance: [...project.gates],
      })
      if (child === undefined)
        return yield* block(project.slug, task, "message limit on the task", cycle.currentTaskId)
      const at = yield* Clock.currentTimeMillis
      yield* moveCycle(sql, ["fix_wait"], {
        ...cycle,
        phase: "fix",
        currentTaskId: child.id,
        workerTasks: [...cycle.workerTasks, child.id],
        sinceMs: at,
      })
    }).pipe(orBlock(project.slug, task, "fix handoff"))

  // A gate failed: one fix per task, the second failure blocks it with a warning.
  const failed = (
    project: ProjectView,
    task: TaskRow,
    cycle: CycleState,
    from: CycleState["phase"],
    note: string,
    what: string,
  ) =>
    Effect.gen(function* () {
      if (cycle.fixes >= MAX_FIXES)
        return yield* block(
          project.slug,
          task,
          `${what} failed again after the fix`,
          cycle.currentTaskId ?? undefined,
        )
      const next = {
        ...cycle,
        phase: "fix_wait",
        fixes: cycle.fixes + 1,
        ciSignal: null,
        fixNote: note,
      } as const
      if (!(yield* moveCycle(sql, [from], next))) return
      yield* fixStart(project, task, next)
    })

  const afterWorker = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      if (cycle.currentTaskId === null) return
      const got = yield* lead.get(yield* leadId(cycle.currentTaskId))
      if (!SETTLED_LEAD.has(got.state)) return
      if (got.state !== "done" || (got.verdict !== undefined && got.verdict.kind !== "ok")) {
        return yield* block(project.slug, task, `worker task ${got.state}`, cycle.currentTaskId)
      }
      const pr = pullOf(got.verdict?.evidence ?? [])
      const number = pr?.number ?? task.pr_number
      if (number === null || number === undefined) {
        return yield* block(project.slug, task, "worker finished without a pull request", cycle.currentTaskId)
      }
      const repo = repoOf(project.repoUrl)
      const headRef =
        task.branch !== null || repo === undefined
          ? undefined
          : yield* gh.prView(repo, number).pipe(
              Effect.map((view) => view.headRef),
              Effect.catch(() => Effect.succeed(undefined)),
            )
      yield* sql`UPDATE project_tasks SET pr_number = ${number}, branch = COALESCE(branch, ${headRef ?? null})
        WHERE project = ${project.slug} AND id = ${task.id}`
      const at = yield* Clock.currentTimeMillis
      if (!(yield* moveCycle(sql, ["work", "fix"], { ...cycle, phase: "ci", sinceMs: at }))) return
      if (stateOf(task.state) === "in_progress") yield* move(project.slug, task.id, "in_review", "pr opened")
    })

  // The worker task a crash left unrecorded: the one the intake created for this board task, from the log.
  const lostWorker = (task: TaskRow, workerBot: string) =>
    Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["task.received"])))
      for (const event of events) {
        const received = decodeReceived(event.payload)
        if (Option.isNone(received)) continue
        const spec = received.value.task
        if (spec.correlationId === task.id && spec.botId === workerBot && spec.parent === undefined)
          return spec
      }
      return undefined
    })

  // A `work` cycle that never got its Lead task (a crash between the cycle row and the intake): adopt the task if the
  // intake did get through, else give the board task back to the queue so the next pass starts it again.
  const recoverOrphan = (project: ProjectView, task: TaskRow, cycle: CycleState) =>
    Effect.gen(function* () {
      const bot = yield* bots.getByName(`worker-${project.slug}`)
      const found = yield* lostWorker(task, bot.id)
      if (found !== undefined) {
        const adopted = yield* moveCycle(sql, ["work"], {
          ...cycle,
          currentTaskId: found.id,
          workerTasks: [found.id],
        })
        return adopted ? "adopted" : "moved"
      }
      yield* move(project.slug, task.id, "ready", "cycle without a task")
      yield* sql`UPDATE project_cycles SET phase = 'settled' WHERE project = ${project.slug} AND task_id = ${task.id}`
      return "requeued"
    }).pipe(orBlock(project.slug, task, "orphan cycle"))

  return { promote, fixStart, failed, afterWorker, recoverOrphan }
}

export type Dispatch = ReturnType<typeof makeDispatch>
