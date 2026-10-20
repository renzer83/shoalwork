import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import {
  type ApprovalId,
  type ApprovalStatus,
  type BotId,
  NotFound,
  newApprovalId,
  type Risk,
  type SessionId,
  type StepId,
  streamIds,
  type TaskId,
  type ToolCall,
} from "@shoalwork/contracts"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type ApprovalRecord, actionHashOf, boundedAction, toRecords } from "./approvals-rows.js"

export { type ApprovalRecord, actionHashOf, boundedAction } from "./approvals-rows.js"

// How long a request waits for a person (02-architecture §7). The caller may pass another ttl.
export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000
export const EXPIRY_ACTOR = "system:approvals"

export interface RequestInput {
  readonly taskId: TaskId
  readonly botId: BotId
  readonly action: ToolCall
  readonly risk: Risk
  readonly stepId?: StepId | undefined
  readonly sessionId?: SessionId | undefined
  readonly ttlMs?: number | undefined
}

export interface ApprovalsOptions {
  // How long a request waits for a person (APPROVAL_TTL_MINUTES). Default: 2 hours.
  readonly ttlMs?: number
}

export type Decision = "approved" | "denied"

// Resolved: this call decided it. AlreadyResolved: someone (or the clock) decided first; the stored approval is returned.
export type ResolveResult =
  | { readonly _tag: "Resolved"; readonly approval: ApprovalRecord }
  | { readonly _tag: "AlreadyResolved"; readonly approval: ApprovalRecord }

export interface ApprovalsShape {
  readonly request: (input: RequestInput) => Effect.Effect<ApprovalRecord, SqlError>
  // One use, idempotent: only the first decision of a pending, unexpired approval takes effect. A pending approval
  // past its expiry is expired here (fail-closed) instead of accepting a late "yes".
  readonly resolve: (
    id: ApprovalId,
    decision: Decision,
    by: string,
  ) => Effect.Effect<ResolveResult, NotFound | SqlError>
  // Pending approvals past their expiry become expired (one approval.resolved each); returns them.
  readonly expireDue: () => Effect.Effect<ReadonlyArray<ApprovalRecord>, SqlError>
  readonly get: (id: ApprovalId) => Effect.Effect<ApprovalRecord, NotFound | SqlError>
  readonly list: (filter?: {
    readonly status?: ApprovalStatus
  }) => Effect.Effect<ReadonlyArray<ApprovalRecord>, SqlError>
  readonly listPending: () => Effect.Effect<ReadonlyArray<ApprovalRecord>, SqlError>
  // The decision is used once: stamps the approval when the run that follows it starts. False when it was already used
  // (or is not decided), and the run must not start.
  readonly consume: (id: ApprovalId) => Effect.Effect<boolean, SqlError>
  // Enforcement for a tool layer that waits for the decision inline (T-055): the approved, unused approval of this task
  // whose action_hash matches tool + input is used up and returned. Anything else (another input, a second use, a
  // denied or expired request) is None and the call must be asked again.
  readonly consumeMatching: (
    taskId: TaskId,
    call: ToolCall,
  ) => Effect.Effect<Option.Option<ApprovalRecord>, SqlError>
  // Pending requests of the task end as expired (a stop, or a task that is no longer waiting): one event each.
  readonly expireForTask: (
    taskId: TaskId,
    by: string,
  ) => Effect.Effect<ReadonlyArray<ApprovalRecord>, SqlError>
  // The newest approval of the task, if it ever asked.
  readonly latestForTask: (taskId: TaskId) => Effect.Effect<Option.Option<ApprovalRecord>, SqlError>
  readonly attachMessage: (
    id: ApprovalId,
    ref: { readonly chatId: string; readonly threadId?: number; readonly messageId: number },
  ) => Effect.Effect<void, SqlError>
}

export class Approvals extends Context.Service<Approvals, ApprovalsShape>()("@shoalwork/Approvals") {}

const isoNow = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

export const makeApprovals = (
  sql: SqlClient,
  beacon: BeaconShape,
  options: ApprovalsOptions = {},
): ApprovalsShape => {
  // Events are part of the approval's own transition: a rejected append is a bug or an outage, so it is a defect.
  const emitResolved = (approval: ApprovalRecord, decision: "approved" | "denied" | "expired", by: string) =>
    beacon
      .append({
        streamId: streamIds.task(approval.taskId),
        type: "approval.resolved",
        payload: { approvalId: approval.id, decision, by },
        actor: by,
        correlationId: approval.taskId,
      })
      .pipe(Effect.orDie, Effect.asVoid)

  const select = (id: ApprovalId) =>
    Effect.gen(function* () {
      const [found] = yield* toRecords(yield* sql`SELECT * FROM approvals WHERE id = ${id}`)
      return found
    })

  const get: ApprovalsShape["get"] = (id) =>
    Effect.flatMap(select(id), (found) =>
      found === undefined ? Effect.fail(new NotFound({ entity: "Approval", id })) : Effect.succeed(found),
    )

  const expire = (at: string, id?: ApprovalId) =>
    Effect.gen(function* () {
      const rows = yield* sql`UPDATE approvals SET status = 'expired', resolved_at = ${at},
        resolved_by = ${EXPIRY_ACTOR}
        WHERE status = 'pending' AND expires_at <= ${at} AND (${id ?? null} IS NULL OR id = ${id ?? null})
        RETURNING *`
      const expired = yield* toRecords(rows)
      yield* Effect.forEach(expired, (approval) => emitResolved(approval, "expired", EXPIRY_ACTOR), {
        discard: true,
      })
      return expired
    })

  const expireTask = (taskId: TaskId, by: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* isoNow
        const rows =
          yield* sql`UPDATE approvals SET status = 'expired', resolved_at = ${at}, resolved_by = ${by}
          WHERE status = 'pending' AND task_id = ${taskId} RETURNING *`
        const expired = yield* toRecords(rows)
        yield* Effect.forEach(expired, (approval) => emitResolved(approval, "expired", by), { discard: true })
        return expired
      }),
    )

  return {
    request: (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // One open request per task: asking again while it is pending returns that request.
          const [open] = yield* toRecords(
            yield* sql`SELECT * FROM approvals WHERE task_id = ${input.taskId} AND status = 'pending'`,
          )
          if (open !== undefined) {
            return open
          }
          const now = yield* Clock.currentTimeMillis
          const id = newApprovalId()
          const action = boundedAction(input.action)
          const requestedAt = new Date(now).toISOString()
          const expiresAt = new Date(now + (input.ttlMs ?? options.ttlMs ?? APPROVAL_TTL_MS)).toISOString()
          yield* sql`INSERT INTO approvals (id, task_id, bot_id, step_id, session_id, action, action_hash, risk,
            status, requested_at, expires_at)
            VALUES (${id}, ${input.taskId}, ${input.botId}, ${input.stepId ?? null}, ${input.sessionId ?? null},
              ${JSON.stringify(action)}, ${actionHashOf(input.action)}, ${input.risk}, 'pending', ${requestedAt}, ${expiresAt})`
          const created = yield* get(id).pipe(Effect.orDie)
          yield* beacon
            .append({
              streamId: streamIds.task(input.taskId),
              type: "approval.requested",
              payload: {
                approvalId: id,
                taskId: input.taskId,
                botId: input.botId,
                action,
                risk: input.risk,
                expiresAt,
              },
              actor: `bot:${input.botId}`,
              correlationId: input.taskId,
            })
            .pipe(Effect.orDie)
          return created
        }),
      ),

    resolve: (id, decision, by) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* isoNow
          const rows =
            yield* sql`UPDATE approvals SET status = ${decision}, resolved_at = ${now}, resolved_by = ${by}
            WHERE id = ${id} AND status = 'pending' AND expires_at > ${now} RETURNING *`
          const [decided] = yield* toRecords(rows)
          if (decided !== undefined) {
            yield* emitResolved(decided, decision, by)
            return { _tag: "Resolved", approval: decided } as const
          }
          // Not decided here: unknown, decided before, or pending past its expiry (which expires now).
          yield* expire(now, id)
          const current = yield* get(id)
          return { _tag: "AlreadyResolved", approval: current } as const
        }),
      ),

    expireDue: () => sql.withTransaction(Effect.flatMap(isoNow, (now) => expire(now))),

    get,

    list: (filter) =>
      Effect.gen(function* () {
        const status = filter?.status ?? null
        return yield* toRecords(
          yield* sql`SELECT * FROM approvals WHERE (${status} IS NULL OR status = ${status})
            ORDER BY requested_at DESC, rowid DESC`,
        )
      }),

    listPending: () =>
      Effect.flatMap(
        sql`SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at, rowid`,
        toRecords,
      ),

    latestForTask: (taskId) =>
      Effect.gen(function* () {
        const [latest] = yield* toRecords(
          yield* sql`SELECT * FROM approvals WHERE task_id = ${taskId}
            ORDER BY requested_at DESC, rowid DESC LIMIT 1`,
        )
        return Option.fromNullishOr(latest)
      }),

    consume: (id) =>
      Effect.gen(function* () {
        const at = yield* isoNow
        const rows = yield* sql`UPDATE approvals SET consumed_at = ${at}
          WHERE id = ${id} AND status IN ('approved', 'denied') AND consumed_at IS NULL RETURNING id`
        return rows.length > 0
      }),

    consumeMatching: (taskId, call) =>
      Effect.gen(function* () {
        const at = yield* isoNow
        // One statement: two concurrent calls cannot both use the same approval.
        const rows = yield* sql`UPDATE approvals SET consumed_at = ${at}
          WHERE consumed_at IS NULL AND id = (
            SELECT id FROM approvals WHERE task_id = ${taskId} AND status = 'approved' AND consumed_at IS NULL
              AND action_hash = ${actionHashOf(call)} ORDER BY resolved_at, rowid LIMIT 1)
          RETURNING *`
        const [used] = yield* toRecords(rows)
        return Option.fromNullishOr(used)
      }),

    expireForTask: expireTask,

    attachMessage: (id, ref) =>
      sql`UPDATE approvals SET chat_id = ${ref.chatId}, thread_id = ${ref.threadId ?? null},
        message_id = ${ref.messageId} WHERE id = ${id}`.pipe(Effect.asVoid),
  }
}

export const makeApprovalsLive = (
  options: ApprovalsOptions = {},
): Layer.Layer<Approvals, never, SqlClient | Beacon> =>
  Layer.effect(
    Approvals,
    Effect.gen(function* () {
      return makeApprovals(yield* SqlClient, yield* Beacon, options)
    }),
  )

export const ApprovalsLive = makeApprovalsLive()
