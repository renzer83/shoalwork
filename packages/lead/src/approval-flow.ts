import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { ApprovalId, NotFound } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import {
  type ApprovalRecord,
  Approvals,
  type ApprovalsShape,
  type Decision,
  type RequestInput,
  type ResolveResult,
} from "@shoalwork/policy"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { extendTokens, pauseForInline, resumeIfIdle } from "./inline-wait.js"
import { TASKS_QUEUE } from "./intake.js"
import { makeLifecycle } from "./lifecycle.js"
import { TaskStore, type TaskStoreShape } from "./tasks.js"
import { blockedVerdict } from "./verdict.js"

export interface ApprovalFlowShape {
  // The one door for a decision, whatever the channel (Telegram, web, CLI): the first decision of a pending request
  // takes effect and queues the task to continue; any later one only reads what was decided (idempotent).
  readonly decide: (
    id: ApprovalId,
    decision: Decision,
    by: string,
  ) => Effect.Effect<ResolveResult, NotFound | SqlError>
  // Requests past their expiry are denied by default: the task that waits on one is closed with a blocked verdict.
  // Resolves with how many approvals expired.
  readonly expireDue: () => Effect.Effect<number, SqlError>
  // The permission bridge asks while its CLI is blocked on the call (T-177): the request is stored as inline and a
  // running task goes to waiting_approval in the same transaction. A decision (or the expiry) puts it back to running;
  // nothing is queued, the run that asked is still alive and reads the answer.
  readonly requestInline: (input: RequestInput) => Effect.Effect<ApprovalRecord, NotFound | SqlError>
}

export class ApprovalFlow extends Context.Service<ApprovalFlow, ApprovalFlowShape>()(
  "@shoalwork/ApprovalFlow",
) {}

export interface ApprovalFlowDeps {
  readonly sql: SqlClient
  readonly approvals: ApprovalsShape
  readonly tasks: TaskStoreShape
  readonly lifecycle: Pick<ReturnType<typeof makeLifecycle>, "transition" | "recordOutcomes" | "taskEvent">
}

// Who ends a pending request whose task is no longer waiting for it.
const TASK_CLOSED_ACTOR = "system:task-closed"

export const makeApprovalFlow = (deps: ApprovalFlowDeps): ApprovalFlowShape => {
  const { sql, approvals, tasks, lifecycle } = deps

  // The request ended without an answer (time ran out): the task waiting on it is closed blocked, fail-closed.
  const closeExpired = (approval: ApprovalRecord) =>
    Effect.gen(function* () {
      const found = yield* tasks.get(approval.taskId).pipe(Effect.option)
      if (Option.isNone(found) || found.value.state !== "waiting_approval") {
        return
      }
      if (approval.mode === "inline") {
        return yield* backToRunning(approval)
      }
      const { spec } = found.value
      const verdict = blockedVerdict("approval expired without an answer", "approval expired")
      // A task that vanished meanwhile has nothing to close.
      yield* lifecycle
        .transition(spec, "failed", { verdict }, "approval expired")
        .pipe(Effect.catchTag("NotFound", () => Effect.void))
      yield* lifecycle.recordOutcomes(spec, "failed")
    })

  // An inline approval ended: the CLI that asked is alive and reads the answer (denied, expired or approved), so the
  // task goes back to running, in one statement and only when no request of it is still pending (a stopped task and a
  // task waiting for a newer request are left alone).
  const backToRunning = (approval: ApprovalRecord) =>
    resumeIfIdle(sql, lifecycle, approval.taskId, "inline approval decided").pipe(Effect.asVoid)

  const requestInline: ApprovalFlowShape["requestInline"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const task = yield* tasks.get(input.taskId)
        const request = yield* approvals.request({ ...input, mode: "inline" })
        if (task.state === "running") {
          yield* pauseForInline(sql, lifecycle, task.spec.id, "waiting for inline approval")
          // The wait is not part of the token's life: it can last as long as the request lives.
          yield* extendTokens(
            sql,
            task.spec.id,
            request.expiresAt.epochMilliseconds - request.requestedAt.epochMilliseconds,
          )
        }
        return request
      }),
    )

  const decide: ApprovalFlowShape["decide"] = (id, decision, by) =>
    // Decision and job in one transaction: either the task is queued to continue, or the approval stays pending.
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* approvals.get(id)
        const task = yield* tasks.get(current.taskId)
        // Inline: the run that asked is blocked on the call and picks the answer up. No resume job, and no expiry
        // because of the task state: the task is waiting only for this request.
        if (current.mode === "inline") {
          const decided = yield* approvals.resolve(id, decision, by)
          if (decided._tag === "Resolved" || decided.approval.status === "expired") {
            yield* backToRunning(decided.approval)
          }
          return decided
        }
        // A task that is no longer waiting (stopped, closed) cannot continue: the request ends, nothing resumes.
        if (current.status === "pending" && task.state !== "waiting_approval") {
          yield* approvals.expireForTask(current.taskId, TASK_CLOSED_ACTOR)
          return { _tag: "AlreadyResolved", approval: yield* approvals.get(id) } as const
        }
        const result = yield* approvals.resolve(id, decision, by)
        if (result._tag === "Resolved") {
          yield* Jobs.enqueue(TASKS_QUEUE, { taskId: task.spec.id }).pipe(
            Effect.provideService(SqlClient, sql),
          )
        } else if (result.approval.status === "expired") {
          // A late click expired the request (the clock passed before the watchdog did): same close as the sweep.
          yield* closeExpired(result.approval)
        }
        return result
      }),
    )

  const expireDue: ApprovalFlowShape["expireDue"] = () =>
    Effect.gen(function* () {
      const expired = yield* approvals.expireDue()
      yield* Effect.forEach(expired, closeExpired, { discard: true })
      return expired.length
    })

  return { decide, expireDue, requestInline }
}

export const ApprovalFlowLive: Layer.Layer<
  ApprovalFlow,
  never,
  SqlClient | Beacon | BotRegistry | TaskStore | Approvals
> = Layer.effect(
  ApprovalFlow,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const tasks = yield* TaskStore
    const approvals = yield* Approvals
    const lifecycle = makeLifecycle({ beacon, tasks, bots })
    return makeApprovalFlow({ sql, approvals, tasks, lifecycle })
  }),
)
