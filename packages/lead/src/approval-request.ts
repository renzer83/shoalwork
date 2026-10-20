import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type Approval,
  addUsage,
  EventPayloads,
  streamIds,
  type TaskId,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import type { ApprovalRecord, ApprovalsShape } from "@shoalwork/policy"
import type { TankShape } from "@shoalwork/tank"
import { Cause, Effect, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { resumeIfIdle } from "./inline-wait.js"
import type { Lifecycle } from "./lifecycle.js"
import { reusableWorktree } from "./resume.js"
import { type ApprovalResume, type Carry, resumeCarry } from "./retry.js"
import type { TaskRecord } from "./tasks.js"
import { describeFailure, isSettled, stepIdFor } from "./verdict.js"

export type ApprovalGate = Pick<ApprovalsShape, "request" | "latestForTask" | "consume" | "expireInline">

export interface ApprovalRunnerDeps {
  readonly approvals: ApprovalGate | undefined
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tank: TankShape
  readonly bots: BotRegistryShape
  readonly lifecycle: Pick<Lifecycle, "raiseError" | "transition" | "finish" | "record" | "taskEvent">
}

type Decided = ApprovalRecord & { readonly status: Exclude<Approval["status"], "pending" | "expired"> }

// Decided (approved or denied) and not yet used: the decision of the pause the task is in.
const isUsable = (approval: ApprovalRecord): approval is Decided =>
  (approval.status === "approved" || approval.status === "denied") && approval.consumedAt === undefined

const decodeUsage = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])

// The runner's side of approvals (T-054): records a pause together with its request, finds the carry that continues a
// task whose approval was decided, and starts that run consuming the decision. Without an Approvals service a task
// still waits, but nothing resumes it.
export const makeApprovalRunner = (deps: ApprovalRunnerDeps) => {
  const { approvals, sql, lifecycle } = deps

  // The task's usage so far, from its usage events: a resumed run spends against the same budget.
  const usageOf = (taskId: TaskId) =>
    Stream.runCollect(deps.beacon.readStream(streamIds.task(taskId), 0)).pipe(
      Effect.map((events) =>
        Array.from(events).reduce((used, event) => {
          const payload = event.type === "usage.recorded" ? decodeUsage(event.payload) : Option.none()
          return Option.isSome(payload) ? addUsage(used, payload.value.usage) : used
        }, ZERO_USAGE),
      ),
    )

  // waiting_approval and the request are stored in ONE transaction: a crash cannot leave a task waiting with nothing
  // to decide, and a decision made at once finds the task waiting. If either fails nothing is stored (recorded =
  // false) and the job is delivered again. Any other outcome is recorded as usual.
  const record: Lifecycle["record"] = (spec, verdict, durationMs, progress, closing) => {
    const outcome = progress.outcome
    if (approvals === undefined || outcome._tag !== "Approval") {
      return lifecycle.record(spec, verdict, durationMs, progress, closing)
    }
    return sql
      .withTransaction(
        lifecycle.finish(spec, verdict, durationMs, progress, closing).pipe(
          Effect.andThen(
            approvals.request({
              taskId: spec.id,
              botId: spec.botId,
              action: outcome.action,
              risk: outcome.risk,
              stepId: progress.stepId,
              sessionId: progress.sessionId,
            }),
          ),
        ),
      )
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : lifecycle
                .raiseError(
                  spec,
                  "lead.approval",
                  describeFailure(Cause.squash(cause)).tag,
                  "could not pause for approval",
                )
                .pipe(Effect.as(false)),
        ),
      )
  }

  // The task goes to running and, when the run follows a decision, the decision is stamped as used: both or neither.
  // A decision already used must not start another run.
  const start = (spec: TaskRecord["spec"], carry: Carry | undefined) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lifecycle.transition(spec, "running", { bumpAttempts: carry?.fallback !== true })
        if (
          carry?.approval !== undefined &&
          approvals !== undefined &&
          !(yield* approvals.consume(carry.approval.id))
        ) {
          return yield* Effect.die("the approval was already used")
        }
      }),
    )

  // The carry of a task waiting for an approval that was approved or denied and not used yet. Undefined while the
  // approval is pending, expired or used, or missing. Database errors are not swallowed: the job is then redelivered.
  const carryFor = (record: TaskRecord) =>
    Effect.gen(function* () {
      if (approvals === undefined || record.state !== "waiting_approval") {
        return undefined
      }
      const latest = yield* approvals.latestForTask(record.spec.id)
      if (Option.isNone(latest) || !isUsable(latest.value)) {
        return undefined
      }
      const found = latest.value
      const approval: ApprovalResume = {
        id: found.id,
        decision: found.status,
        tool: found.action.tool,
        input: typeof found.action.input === "string" ? found.action.input : "",
        resource: found.action.resource,
      }
      const { spec } = record
      const usage = yield* usageOf(spec.id)
      const stepId = found.stepId ?? stepIdFor(spec.id, Math.max(1, record.attempts))
      const repo = spec.repo
      const reuse =
        repo === undefined || found.stepId === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const bot = yield* deps.bots.get(spec.botId)
              return yield* reusableWorktree(deps, bot, repo, stepId)
            }).pipe(Effect.orElseSucceed(() => undefined))
      if (repo !== undefined && reuse === undefined) {
        // The worktree of the paused run is gone: the work cannot be continued where it stopped, so the run starts
        // on a new step (a real attempt) and only the decision travels.
        return {
          ...resumeCarry({ stepId, worktree: undefined, sessionId: undefined, usage, approval }),
          stepId: stepIdFor(spec.id, record.attempts + 1),
          fallback: false,
        } satisfies Carry
      }
      return resumeCarry({
        stepId,
        worktree: reuse,
        sessionId: found.sessionId ?? record.sessionId,
        usage,
        approval,
      })
    })

  // The run is over, however it ended (done, failed, budget, stop, crash, retry): whoever waited on an inline request
  // is gone, so the requests end as expired and the task is running again before anything else is decided about it.
  const endInline = (spec: TaskRecord["spec"]) =>
    approvals === undefined
      ? Effect.void
      : approvals.expireInline(spec.id, "system:run-ended").pipe(
          Effect.andThen(resumeIfIdle(sql, lifecycle, spec.id, "run ended during an inline approval")),
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : lifecycle.raiseError(
                  spec,
                  "lead.approval",
                  describeFailure(Cause.squash(cause)).tag,
                  "could not end the inline approval",
                ),
          ),
        )

  // A waiting task is settled (a job for it has nothing to run) unless its approval was decided and not used.
  const settledFor = (approved: Carry | undefined) => (state: TaskRecord["state"]) =>
    isSettled(state) && !(approved !== undefined && state === "waiting_approval")

  return { record, start, carryFor, settledFor, endInline }
}
