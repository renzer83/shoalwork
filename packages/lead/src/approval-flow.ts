import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { ApprovalId, NotFound } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import {
  type ApprovalRecord,
  Approvals,
  type ApprovalsShape,
  type Decision,
  type ResolveResult,
} from "@shoalwork/policy"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
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
}

export class ApprovalFlow extends Context.Service<ApprovalFlow, ApprovalFlowShape>()(
  "@shoalwork/ApprovalFlow",
) {}

export interface ApprovalFlowDeps {
  readonly sql: SqlClient
  readonly approvals: ApprovalsShape
  readonly tasks: TaskStoreShape
  readonly lifecycle: Pick<ReturnType<typeof makeLifecycle>, "transition" | "recordOutcomes">
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
      const { spec } = found.value
      const verdict = blockedVerdict("approval expired without an answer", "approval expired")
      // A task that vanished meanwhile has nothing to close.
      yield* lifecycle
        .transition(spec, "failed", { verdict }, "approval expired")
        .pipe(Effect.catchTag("NotFound", () => Effect.void))
      yield* lifecycle.recordOutcomes(spec, "failed")
    })

  const decide: ApprovalFlowShape["decide"] = (id, decision, by) =>
    // Decision and job in one transaction: either the task is queued to continue, or the approval stays pending.
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* approvals.get(id)
        const task = yield* tasks.get(current.taskId)
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

  return { decide, expireDue }
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
