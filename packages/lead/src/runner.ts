import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  addUsage,
  type Bot,
  type EventType,
  type ExecutorEvent,
  type ExecutorProtocolError,
  type ExecutorSpawnError,
  type ExecutorTask,
  type StepId,
  streamIds,
  type TaskId,
  type TaskSpec,
  type TaskState,
  usageToBudget,
  type Verdict,
} from "@shoalwork/contracts"
import type { ExecutorRegistry } from "@shoalwork/executors"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Cause, Clock, Duration, Effect, Exit, Option, Ref, type Scope, Stream } from "effect"
import { deliverCode } from "./git-delivery.js"
import { emit, type TaskStoreShape } from "./tasks.js"
import {
  ACTOR,
  blockedVerdict,
  buildPrompt,
  clip,
  describeFailure,
  finalTaskState,
  INITIAL,
  isNotFound,
  isSettled,
  type Progress,
  REAPED_EVIDENCE,
  SUMMARY_MAX,
  stepIdFor,
  verdictFor,
  withArtifact,
  withOutcome,
} from "./verdict.js"

// What a Bot may run in a code task. Commit, push and PR are the Lead's job (git-delivery.ts), not the Bot's.
const CODE_ALLOWED_TOOLS: ReadonlyArray<string> = [
  "Bash(pnpm *)",
  "Bash(npm *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
]

export interface LeadConfig {
  readonly maxTurns: number
  readonly heartbeatMs: number
  // A job whose heartbeat is older than this is considered abandoned and gets requeued by the worker's reaper.
  readonly staleSeconds: number
  readonly reapEveryMs: number
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  maxTurns: 50,
  heartbeatMs: 30_000,
  staleSeconds: 120,
  reapEveryMs: 60_000,
}

export interface RunResult {
  readonly verdict: Verdict
  readonly recorded: boolean
}

export interface RunnerDeps {
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  readonly tank: TankShape
  readonly executors: typeof ExecutorRegistry.Service
  readonly config: LeadConfig
}

export const makeRunner = (deps: RunnerDeps) => {
  const { beacon, tasks, bots, tank, executors, config } = deps

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

  const transition = (spec: TaskSpec, to: TaskState, patch: Parameters<TaskStoreShape["update"]>[1] = {}) =>
    Effect.gen(function* () {
      const from = yield* tasks.update(spec.id, { ...patch, state: to })
      if (from !== to) {
        yield* taskEvent(spec.id, "task.state_changed", { taskId: spec.id, from, to })
      }
    })

  // Only an ok run of a code task with a repo is delivered, inside the worktree the Bot wrote to (before release).
  // A failed delivery turns the outcome into a Delivery failure, so the verdict is not ok and the worktree is kept.
  const deliver = (spec: TaskSpec, ctx: TankContext, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      const { outcome } = yield* Ref.get(progress)
      if (outcome._tag !== "Done" || spec.kind !== "code" || spec.repo === undefined) return
      yield* deliverCode(tank, ctx, {
        taskId: spec.id,
        title: spec.title,
        base: spec.repo.base,
        issue: spec.repo.issue,
      }).pipe(
        Effect.flatMap((artifact) => Ref.update(progress, withArtifact(artifact))),
        Effect.catch((failure) =>
          Effect.gen(function* () {
            yield* raiseError(spec, "lead.delivery", failure._tag, failure.message)
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "Delivery", step: failure.step, message: failure.message }),
            )
          }),
        ),
      )
    })

  // Consumes the executor stream until its first terminal event (or an approval request), recording every event.
  const consume = (
    spec: TaskSpec,
    bot: Bot,
    executorId: string,
    stream: Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope>,
    stepId: StepId,
    progress: Ref.Ref<Progress>,
    model: string,
  ) => {
    const ids = { taskId: spec.id, stepId, botId: bot.id }
    const handle = (event: ExecutorEvent): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        yield* taskEvent(spec.id, "executor.event", { ...ids, event })
        switch (event.kind) {
          case "started": {
            if (event.sessionId !== undefined) {
              const sessionId = event.sessionId
              yield* Ref.update(progress, (p) => ({ ...p, sessionId }))
            }
            return true
          }
          case "usage": {
            yield* Ref.update(progress, (p) => ({ ...p, usage: addUsage(p.usage, event.usage) }))
            yield* taskEvent(spec.id, "usage.recorded", {
              ...ids,
              executor: executorId,
              model,
              usage: event.usage,
            })
            return true
          }
          case "approval_needed": {
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "Approval", action: event.action, risk: event.risk }),
            )
            return false
          }
          case "done": {
            yield* Ref.update(progress, (p) => ({
              ...p,
              sessionId: event.sessionId ?? p.sessionId,
              outcome: { _tag: "Done", result: event.result } as const,
            }))
            return false
          }
          case "error": {
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "ExecutorError", code: event.code, message: event.message }),
            )
            return false
          }
          default:
            return true
        }
      })

    return stream.pipe(
      Stream.runForEachWhile(handle),
      Effect.scoped,
      Effect.provideService(Tank, tank),
      // Typed adapter failures are results of the run, not bugs.
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Ref.update(
            progress,
            withOutcome({ _tag: "Channel", tag: error._tag, executor: error.executor }),
          )
          yield* raiseError(spec, "executor", error._tag, `executor ${error.executor} failed`)
        }),
      ),
    )
  }

  // Everything between "running" and the verdict. Never fails: problems become the progress outcome.
  const execute = (spec: TaskSpec, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      yield* transition(spec, "running", { bumpAttempts: true })
      const { attempts } = yield* tasks.get(spec.id)
      const stepId = stepIdFor(spec.id, attempts)
      yield* Ref.update(progress, (p) => ({ ...p, stepId }))
      // Another task of the same Bot may already have set it.
      const states = yield* bots.list()
      if (states.find((b) => b.id === spec.botId)?.state !== "working") {
        yield* bots.setState(spec.botId, "working", spec.id)
      }
      const bot = yield* bots.get(spec.botId)
      const executor = yield* executors.get(bot.executors.preferred)
      const task: ExecutorTask = {
        taskId: spec.id,
        stepId,
        botId: bot.id,
        prompt: buildPrompt(spec),
        tier: spec.tier,
        allowedTools: spec.kind === "code" && spec.repo !== undefined ? [...CODE_ALLOWED_TOOLS] : [],
        permissionMode: "edit",
        maxTurns: config.maxTurns,
        budget: spec.budget,
      }
      const model = executor.mapTier(spec.tier).model
      const use = (ctx: TankContext) =>
        Effect.gen(function* () {
          yield* taskEvent(spec.id, "executor.started", {
            taskId: spec.id,
            stepId,
            botId: bot.id,
            executor: executor.id,
            model,
            cwd: ctx.cwd,
          })
          yield* consume(spec, bot, executor.id, executor.run(task, ctx), stepId, progress, model)
          yield* deliver(spec, ctx, progress)
        })
      // Keep the worktree for diagnosis unless the run ended in an ok verdict.
      const release = (ctx: TankContext, exit: Exit.Exit<void, unknown>) =>
        Effect.gen(function* () {
          const ok = Exit.isSuccess(exit) && (yield* Ref.get(progress)).outcome._tag === "Done"
          yield* tank
            .release(ctx, { keepWorktree: !ok })
            .pipe(
              Effect.catch((error) =>
                raiseError(spec, "tank.release", error._tag, describeFailure(error).message),
              ),
            )
        })
      // Like acquireUseRelease, but prepare stays interruptible so the time budget also covers it
      // (interrupting it tears down the Tank's process group); once a context exists, release always runs.
      const run = Effect.uninterruptibleMask((restore) =>
        restore(tank.prepare(bot, { stepId, ...(spec.repo === undefined ? {} : { repo: spec.repo }) })).pipe(
          Effect.flatMap((ctx) => restore(use(ctx)).pipe(Effect.onExit((exit) => release(ctx, exit)))),
        ),
      )
      const finished = yield* run.pipe(Effect.timeoutOption(Duration.seconds(spec.budget.seconds)))
      if (Option.isNone(finished)) {
        yield* Ref.update(progress, withOutcome({ _tag: "TimedOut" }))
      }
    })

  const finish = (spec: TaskSpec, verdict: Verdict, durationMs: number, progress: Progress) =>
    Effect.gen(function* () {
      const final = finalTaskState(verdict)
      if (verdict.kind === "budget_exceeded") {
        yield* taskEvent(spec.id, "budget.exceeded", {
          scope: "task",
          refId: spec.id,
          limit: spec.budget,
          used: { ...usageToBudget(progress.usage), seconds: verdict.cost.seconds },
        })
      }
      yield* taskEvent(spec.id, "executor.finished", {
        taskId: spec.id,
        ...(progress.stepId === undefined ? {} : { stepId: progress.stepId }),
        botId: spec.botId,
        verdict,
        ...(verdict.sessionId === undefined ? {} : { sessionId: verdict.sessionId }),
        durationMs,
      })
      yield* transition(spec, final, {
        verdict,
        ...(verdict.sessionId === undefined ? {} : { sessionId: verdict.sessionId }),
      })
      // The Bot is free only when none of its tasks is still running.
      if ((yield* tasks.countRunning(spec.botId)) === 0) {
        yield* bots.setState(spec.botId, "idle", spec.id)
      }
    })

  // recorded = false means the verdict could not be written down (database trouble): the caller must NOT
  // consider the job done, so the queue delivers the task again.
  const runTask = (id: TaskId): Effect.Effect<RunResult> =>
    Effect.gen(function* () {
      const record = yield* tasks.get(id)
      // A job delivered twice (reaped lock, retry of the queue entry) must not run the task again.
      if (isSettled(record.state)) {
        return {
          verdict: record.verdict ?? blockedVerdict(`task is ${record.state}`, "settled"),
          recorded: true,
        }
      }
      const spec = record.spec
      const started = yield* Clock.currentTimeMillis
      const progress = yield* Ref.make(INITIAL)

      const exit = yield* Effect.exit(execute(spec, progress))
      if (Exit.isFailure(exit)) {
        const { tag, message } = describeFailure(Cause.squash(exit.cause))
        yield* raiseError(spec, "lead.runOnce", tag, message)
        yield* Ref.update(progress, withOutcome({ _tag: "Failure", tag, message }))
      }

      const ended = yield* Clock.currentTimeMillis
      const durationMs = Math.max(0, ended - started)
      const finalProgress = yield* Ref.get(progress)
      const verdict = verdictFor(finalProgress, Math.round(durationMs / 1000))
      const recorded = yield* finish(spec, verdict, durationMs, finalProgress).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : raiseError(
                spec,
                "lead.finish",
                describeFailure(Cause.squash(cause)).tag,
                "could not record the verdict",
              ).pipe(Effect.as(false)),
        ),
      )
      return { verdict, recorded }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt
        }
        const failure = Cause.squash(cause)
        const { tag, message } = describeFailure(failure)
        return taskEvent(id, "error.raised", { where: "lead.runOnce", tag, message, taskId: id }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.as({
            verdict: blockedVerdict(clip(`${tag}: ${message}`, SUMMARY_MAX), tag),
            // A task that does not exist will not appear on a retry; any other failure may be transient.
            recorded: isNotFound(failure),
          }),
        )
      }),
    )

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

  return { runTask, abandon }
}
