import type { TaskId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Lifecycle } from "./lifecycle.js"

// Inline approvals (T-177): the CLI of a run is blocked on a tool call while a person decides. The task is
// waiting_approval for that time, and the time does not count against the task's budget.

const Waits = Schema.Array(
  Schema.Struct({
    requested_at: Schema.String,
    resolved_at: Schema.NullOr(Schema.String),
    expires_at: Schema.String,
  }),
)

// Milliseconds the task spent blocked on inline approvals requested since `sinceMs`. A pending request counts up to
// now (or its expiry, whichever comes first).
export const inlineWaitedMs = (
  sql: SqlClient,
  taskId: TaskId,
  sinceMs: number,
  nowMs: number,
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT requested_at, resolved_at, expires_at FROM approvals
      WHERE task_id = ${taskId} AND mode = 'inline' AND requested_at >= ${new Date(sinceMs).toISOString()}`
    const waits = yield* Schema.decodeUnknownEffect(Waits)(rows).pipe(Effect.orDie)
    return waits.reduce((total, row) => {
      const end =
        row.resolved_at === null ? Math.min(nowMs, Date.parse(row.expires_at)) : Date.parse(row.resolved_at)
      return total + Math.max(0, end - Date.parse(row.requested_at))
    }, 0)
  })

// What the budget clock reads: the inline wait since `sinceMs`, never failing (a database error counts as no wait).
export const waitedSince = (sql: SqlClient, taskId: TaskId) => (sinceMs: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => inlineWaitedMs(sql, taskId, sinceMs, now)).pipe(
    Effect.orElseSucceed(() => 0),
  )

type Events = Pick<Lifecycle, "taskEvent">

// running -> waiting_approval in one statement, so a stop that cancelled the task in between is never undone.
export const pauseForInline = (sql: SqlClient, events: Events, taskId: TaskId, reason: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`UPDATE tasks SET state = 'waiting_approval', updated_at = ${nowIso()}
      WHERE id = ${taskId} AND state = 'running' RETURNING id`
    if (rows.length > 0) {
      yield* events.taskEvent(taskId, "task.state_changed", {
        taskId,
        from: "running",
        to: "waiting_approval",
        reason,
      })
    }
  })

// waiting_approval -> running when the task has no request left pending, in one statement. A task that was stopped
// meanwhile (or is waiting for another request) stays as it is.
export const resumeIfIdle = (sql: SqlClient, events: Events, taskId: TaskId, reason: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`UPDATE tasks SET state = 'running', updated_at = ${nowIso()}
      WHERE id = ${taskId} AND state = 'waiting_approval'
        AND NOT EXISTS (SELECT 1 FROM approvals WHERE task_id = ${taskId} AND status = 'pending')
      RETURNING id`
    if (rows.length > 0) {
      yield* events.taskEvent(taskId, "task.state_changed", {
        taskId,
        from: "waiting_approval",
        to: "running",
        reason,
      })
    }
    return rows.length > 0
  })

// The execution token must outlive the wait: it is pushed forward by the longest the request can wait.
export const extendTokens = (sql: SqlClient, taskId: TaskId, ms: number) =>
  sql`UPDATE mcp_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, ${`+${Math.max(0, ms) / 1000} seconds`})
    WHERE task_id = ${taskId} AND revoked_at IS NULL`.pipe(Effect.asVoid)
