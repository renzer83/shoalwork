import type { BotRegistryShape } from "@shoalwork/bots"
import { type TaskId, TaskId as TaskIdSchema } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Cause, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { TASKS_QUEUE } from "./intake.js"
import type { Lifecycle } from "./lifecycle.js"
import { killOrphanGroups } from "./run-processes.js"
import type { TaskStoreShape } from "./tasks.js"
import { blockedVerdict, describeFailure, INITIAL } from "./verdict.js"

export const RESTART_REASON = "process restarted"
export const RESUME_REASON = "process restarted, resuming"
// A task caught in `planning` by a restart: planning calls a model and holds no job, so it is not continued.
export const PLANNING_RESTART_REASON = "process restarted during planning"

// The task's open jobs are closed for good, without a retry: attempts = max_attempts.
export const closeJobsOf = (sql: SqlClient, taskId: TaskId, error: string) =>
  sql`UPDATE jobs SET state = 'failed', last_error = ${error}, attempts = max_attempts,
      locked_at = NULL, heartbeat_at = NULL
    WHERE queue = ${TASKS_QUEUE} AND json_extract(payload, '$.taskId') = ${taskId}
      AND state IN ('queued', 'active')`

const IdRow = Schema.Struct({ id: TaskIdSchema })
const JobRow = Schema.Struct({
  id: Schema.Int,
  state: Schema.String,
  attempts: Schema.Int,
  max_attempts: Schema.Int,
})

export interface RecoveryReport {
  // Tasks put back in the queue to continue where they were.
  readonly resumed: ReadonlyArray<TaskId>
  // Tasks closed as failed: no attempt left, or no job to run them again.
  readonly failed: ReadonlyArray<TaskId>
}

export interface RecoveryDeps {
  readonly sql: SqlClient
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  readonly lifecycle: Lifecycle
}

// Boot step. A task still `planning` is closed as failed (blocked verdict): the plan, if the model had answered, was
// never stored, so nothing is lost and the task can be submitted again.
// A task still `running` in the database belonged to a process that died. Its leftover Tank processes
// are killed; then, while its job has attempts left, the job goes back to the queue and the task stays running
// (the runner continues it); otherwise it fails. The job's attempts are kept, so a task that keeps killing the
// process runs out of attempts. One task's trouble never stops the others.
export const makeRecovery =
  ({ sql, tasks, bots, lifecycle }: RecoveryDeps) =>
  (): Effect.Effect<RecoveryReport> =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT id FROM tasks WHERE state = 'running'`.pipe(Effect.orDie)
      const ids = (yield* Schema.decodeUnknownEffect(Schema.Array(IdRow))(rows).pipe(Effect.orDie)).map(
        (row) => row.id,
      )
      const planningRows = yield* sql`SELECT id FROM tasks WHERE state = 'planning'`.pipe(Effect.orDie)
      const planningIds = (yield* Schema.decodeUnknownEffect(Schema.Array(IdRow))(planningRows).pipe(
        Effect.orDie,
      )).map((row) => row.id)
      const resumed: Array<TaskId> = []
      const failed: Array<TaskId> = []

      const failPlanning = (id: TaskId) =>
        Effect.gen(function* () {
          const { spec } = yield* tasks.get(id)
          const verdict = blockedVerdict(PLANNING_RESTART_REASON, PLANNING_RESTART_REASON)
          yield* lifecycle.transition(spec, "failed", { verdict }, PLANNING_RESTART_REASON)
          yield* lifecycle.recordOutcomes(spec, "failed")
          yield* closeJobsOf(sql, id, PLANNING_RESTART_REASON)
          failed.push(id)
        })

      const recover = (id: TaskId, planning = false) =>
        Effect.gen(function* () {
          if (planning) {
            return yield* failPlanning(id)
          }
          const { spec } = yield* tasks.get(id)
          yield* killOrphanGroups(sql, id)
          const jobs = yield* sql`SELECT id, state, attempts, max_attempts FROM jobs
            WHERE queue = ${TASKS_QUEUE} AND json_extract(payload, '$.taskId') = ${id}
            ORDER BY id DESC LIMIT 1`
          const [job] = yield* Schema.decodeUnknownEffect(Schema.Array(JobRow))(jobs).pipe(Effect.orDie)
          const open = job !== undefined && (job.state === "active" || job.state === "queued")
          if (job !== undefined && open && job.attempts < job.max_attempts) {
            yield* sql`UPDATE jobs SET state = 'queued', run_at = ${nowIso()}, locked_at = NULL, heartbeat_at = NULL
              WHERE id = ${job.id}`
            yield* lifecycle.taskEvent(id, "task.state_changed", {
              taskId: id,
              from: "running",
              to: "running",
              reason: RESUME_REASON,
            })
            // The Bot was working when the process died; a paused Bot stays paused.
            const bot = (yield* bots.list()).find((entry) => entry.id === spec.botId)
            if (bot !== undefined && bot.state !== "paused" && bot.state !== "working") {
              yield* bots.setState(spec.botId, "working", id)
            }
            resumed.push(id)
            return
          }
          const verdict = blockedVerdict(RESTART_REASON, RESTART_REASON)
          yield* lifecycle.finish(spec, verdict, 0, INITIAL, "settle", RESTART_REASON)
          yield* closeJobsOf(sql, id, RESTART_REASON)
          failed.push(id)
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt
            }
            const { tag } = describeFailure(Cause.squash(cause))
            return Effect.logError("could not recover an orphan task", tag).pipe(
              Effect.andThen(
                lifecycle.taskEvent(id, "error.raised", {
                  where: "lead.recover",
                  tag,
                  message: "could not recover the task after a restart",
                  taskId: id,
                }),
              ),
              Effect.catchCause(() => Effect.void),
            )
          }),
          Effect.annotateLogs({ taskId: id }),
        )

      yield* Effect.forEach(ids, (id) => recover(id), { discard: true })
      yield* Effect.forEach(planningIds, (id) => recover(id, true), { discard: true })
      return { resumed, failed }
    })
