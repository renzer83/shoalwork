import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type EventType,
  streamIds,
  type TaskId,
  type TaskSpec,
  type TaskState,
  usageToBudget,
  type Verdict,
} from "@shoalwork/contracts"
import { Cause, Effect } from "effect"
import { isTerminal, makeOutcomes } from "./outcomes.js"
import { emit, type TaskStoreShape } from "./tasks.js"
import {
  ACTOR,
  blockedVerdict,
  describeFailure,
  finalTaskState,
  INITIAL,
  isSettled,
  type Progress,
  REAPED_EVIDENCE,
} from "./verdict.js"

export interface LifecycleDeps {
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
}

// Event and state recording for one task: everything the runner writes about a task other than the executor stream.
export const makeLifecycle = ({ beacon, tasks, bots }: LifecycleDeps) => {
  const taskEvent = (taskId: TaskId, type: EventType, payload: unknown) =>
    emit(beacon, {
      streamId: streamIds.task(taskId),
      type,
      payload,
      actor: ACTOR,
      correlationId: taskId,
    })

  // Reporting a problem must not hide the problem that is being reported.
  const raiseError = (spec: Pick<TaskSpec, "id" | "botId">, where: string, tag: string, message: string) =>
    taskEvent(spec.id, "error.raised", { where, tag, message, taskId: spec.id, botId: spec.botId }).pipe(
      Effect.catchCause(() => Effect.void),
    )

  const outcomes = makeOutcomes(beacon)

  // Outcomes are derived data: a failure to write them is reported as an error event, never a failed task.
  const recordOutcomes = (spec: TaskSpec, state: TaskState): Effect.Effect<void> =>
    outcomes.recordTaskOutcomes(spec.id, state).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.gen(function* () {
              const failure = describeFailure(Cause.squash(cause))
              yield* raiseError(spec, "lead.outcomes", failure.tag, failure.message)
            }),
      ),
    )

  const transition = (
    spec: TaskSpec,
    to: TaskState,
    patch: Parameters<TaskStoreShape["update"]>[1] = {},
    reason?: string,
  ) =>
    Effect.gen(function* () {
      const from = yield* tasks.update(spec.id, { ...patch, state: to })
      if (from !== to) {
        yield* taskEvent(spec.id, "task.state_changed", {
          taskId: spec.id,
          from,
          to,
          ...(reason === undefined ? {} : { reason }),
        })
      }
    })

  // "retry": this run failed in a way another attempt may fix; the task stays running.
  // "exhausted": a retryable failure with no attempt left; the task fails and the Bot is blocked.
  // "settle": the verdict is final in the ordinary way.
  const finish = (
    spec: TaskSpec,
    verdict: Verdict,
    durationMs: number,
    progress: Progress,
    closing: "retry" | "exhausted" | "settle" = "settle",
  ) =>
    Effect.gen(function* () {
      const sessionPatch = verdict.sessionId === undefined ? {} : { sessionId: verdict.sessionId }
      if (closing === "retry") {
        yield* recordAttempt(spec, verdict, durationMs, progress)
        // No verdict is stored: the task is still running, and a stored verdict would read as final.
        yield* tasks.update(spec.id, sessionPatch)
        return
      }
      if (verdict.kind === "budget_exceeded") {
        yield* taskEvent(spec.id, "budget.exceeded", {
          scope: "task",
          refId: spec.id,
          limit: spec.budget,
          used: { ...usageToBudget(progress.usage), seconds: verdict.cost.seconds },
        })
      }
      yield* recordAttempt(spec, verdict, durationMs, progress)
      const exhausted = closing === "exhausted"
      const next = finalTaskState(verdict)
      yield* transition(spec, next, { verdict, ...sessionPatch }, exhausted ? "max retries" : undefined)
      // Terminal outcome of every Reflex decision of this task (idempotent; see outcomes.ts).
      if (isTerminal(next)) {
        yield* recordOutcomes(spec, next)
      }
      // The Bot is free only when none of its tasks is still running; after exhausted retries it is blocked.
      if ((yield* tasks.countRunning(spec.botId)) === 0) {
        yield* bots.setState(spec.botId, exhausted ? "blocked" : "idle", spec.id)
      }
    })

  // One executor.finished per run, whatever the run ended with.
  const recordAttempt = (spec: TaskSpec, verdict: Verdict, durationMs: number, progress: Progress) =>
    taskEvent(spec.id, "executor.finished", {
      taskId: spec.id,
      ...(progress.stepId === undefined ? {} : { stepId: progress.stepId }),
      botId: spec.botId,
      verdict,
      ...(verdict.sessionId === undefined ? {} : { sessionId: verdict.sessionId }),
      durationMs,
    })

  // The queue gave up on the task's job (all attempts used, worker never reported back): close the task.
  const abandon = (id: TaskId, reason: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const record = yield* tasks.get(id)
      if (isSettled(record.state)) {
        return
      }
      const verdict = blockedVerdict(reason, REAPED_EVIDENCE)
      yield* raiseError(record.spec, "lead.reaper", "JobReaped", reason)
      yield* finish(record.spec, verdict, 0, INITIAL)
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("could not close an abandoned task", describeFailure(Cause.squash(cause)).tag),
      ),
      Effect.annotateLogs({ taskId: id }),
    )

  return { taskEvent, raiseError, transition, finish, abandon }
}

export type Lifecycle = ReturnType<typeof makeLifecycle>
