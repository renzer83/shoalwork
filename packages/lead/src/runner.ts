import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type ExecutorTask, type TaskId, type TaskSpec, type Verdict, ZERO_USAGE } from "@shoalwork/contracts"
import type { ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Clock, Duration, Effect, Exit, Option, Ref } from "effect"
import { chooseExecutor } from "./choose.js"
import { makeConsume } from "./consume.js"
import { deliverCode } from "./git-delivery.js"
import { makeLifecycle } from "./lifecycle.js"
import { buildRetryPrompt, type Carry, decideRetry, MIN_RETRY_BUDGET_MS, type RoundResult } from "./retry.js"
import type { TaskStoreShape } from "./tasks.js"
import {
  blockedVerdict,
  buildPrompt,
  clip,
  describeFailure,
  INITIAL,
  isNotFound,
  isSettled,
  type Progress,
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
  // Time budget a task must still have left to start another run (retry.ts).
  readonly minRetryBudgetMs: number
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  maxTurns: 50,
  heartbeatMs: 30_000,
  staleSeconds: 120,
  reapEveryMs: 60_000,
  minRetryBudgetMs: MIN_RETRY_BUDGET_MS,
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
  // config/model-tiers.yaml (or its defaults): decides which executor serves each task tier.
  readonly tiers: TierConfig
  readonly config: LeadConfig
}

// Retries run inside the same runTask call, so the job's lock and heartbeat cover them and the task's time budget
// is spent once for all rounds. Each run records one executor.finished; only the last one settles the task.
export const makeRunner = (deps: RunnerDeps) => {
  const { beacon, tasks, bots, tank, executors, tiers, config } = deps
  const { taskEvent, raiseError, transition, finish, abandon } = makeLifecycle({ beacon, tasks, bots })
  const consume = makeConsume({ taskEvent, raiseError, tank })

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

  // One executor run, from transition to running until the worktree is released. A retry (carry) continues the
  // previous run's step: same worktree and branch, and the executor session when there is one.
  // Resolves with the context when the run reached its end; never fails: problems become the progress outcome.
  const execute = (
    spec: TaskSpec,
    progress: Ref.Ref<Progress>,
    carry: Carry | undefined,
    budgetLeftMs: number,
  ) =>
    Effect.gen(function* () {
      // A resume that failed and runs fresh is the same attempt: only real attempts use up the limit.
      yield* transition(spec, "running", { bumpAttempts: carry?.fallback !== true })
      const { attempts } = yield* tasks.get(spec.id)
      const stepId = carry?.stepId ?? stepIdFor(spec.id, attempts)
      yield* Ref.update(progress, (p) => ({ ...p, stepId, attempt: attempts }))
      // Another task of the same Bot may already have set it.
      const states = yield* bots.list()
      if (states.find((b) => b.id === spec.botId)?.state !== "working") {
        yield* bots.setState(spec.botId, "working", spec.id)
      }
      const bot = yield* bots.get(spec.botId)
      const chosen = yield* chooseExecutor(tiers, bot, spec.tier, executors)
      if (Option.isNone(chosen)) {
        const message = `no executor available for tier ${spec.tier}`
        yield* raiseError(spec, "lead.executor", "NoExecutor", message)
        yield* Ref.update(progress, withOutcome({ _tag: "NoExecutor", tier: spec.tier }))
        return Option.none()
      }
      // The model and effort the tier table (or the Bot override) resolved travel in the task: the adapter's argv
      // uses them, and executor.started reports the same model.
      const { executor, model, effort } = chosen.value
      const resumeSessionId = carry?.sessionId
      const task: ExecutorTask = {
        taskId: spec.id,
        stepId,
        botId: bot.id,
        prompt: carry === undefined ? buildPrompt(spec) : buildRetryPrompt(spec, { tail: carry.tail }),
        tier: spec.tier,
        allowedTools: spec.kind === "code" && spec.repo !== undefined ? [...CODE_ALLOWED_TOOLS] : [],
        permissionMode: "edit",
        maxTurns: config.maxTurns,
        budget: spec.budget,
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      }
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
        }).pipe(Effect.as(ctx))
      // Keep the worktree for diagnosis unless the run ended in an ok verdict.
      const release = (ctx: TankContext, exit: Exit.Exit<unknown, unknown>) =>
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
      const prepared = {
        stepId,
        ...(spec.repo === undefined ? {} : { repo: spec.repo }),
        ...(carry?.worktree === undefined ? {} : { reuse: carry.worktree }),
      }
      // Like acquireUseRelease, but prepare stays interruptible so the time budget also covers it
      // (interrupting it tears down the Tank's process group); once a context exists, release always runs.
      const run = Effect.uninterruptibleMask((restore) =>
        restore(tank.prepare(bot, prepared)).pipe(
          Effect.flatMap((ctx) => restore(use(ctx)).pipe(Effect.onExit((exit) => release(ctx, exit)))),
        ),
      )
      const finished = yield* run.pipe(Effect.timeoutOption(Duration.millis(Math.max(0, budgetLeftMs))))
      if (Option.isNone(finished)) {
        yield* Ref.update(progress, withOutcome({ _tag: "TimedOut" }))
      }
      return finished
    })

  // One run of the task, with what its verdict and the retry decision need. Never fails.
  const runRound = (
    spec: TaskSpec,
    carry: Carry | undefined,
    budgetLeftMs: number,
  ): Effect.Effect<RoundResult> =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>({ ...INITIAL, usage: carry?.usage ?? ZERO_USAGE })
      const started = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(execute(spec, progress, carry, budgetLeftMs))
      let worktree: RoundResult["worktree"]
      if (Exit.isSuccess(exit)) {
        worktree = Option.getOrUndefined(exit.value)?.worktree
      } else {
        const { tag, message } = describeFailure(Cause.squash(exit.cause))
        yield* raiseError(spec, "lead.runOnce", tag, message)
        yield* Ref.update(progress, withOutcome({ _tag: "Failure", tag, message }))
      }
      const ended = yield* Clock.currentTimeMillis
      return { progress: yield* Ref.get(progress), durationMs: Math.max(0, ended - started), worktree }
    })

  // recorded = false means the round could not be written down (database trouble).
  const record = (
    spec: TaskSpec,
    verdict: Verdict,
    durationMs: number,
    progress: Progress,
    closing: "retry" | "exhausted" | "settle",
  ): Effect.Effect<boolean> =>
    finish(spec, verdict, durationMs, progress, closing).pipe(
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

  // Rounds until a verdict is final. A round that ends in a retryable failure records its executor.finished and leaves
  // the task running; the next round starts from its carry. Only the last round settles the task.
  const rounds = (spec: TaskSpec, started: number, carry: Carry | undefined): Effect.Effect<RunResult> =>
    Effect.gen(function* () {
      const budgetMs = spec.budget.seconds * 1000
      const roundStart = yield* Clock.currentTimeMillis
      const round = yield* runRound(spec, carry, budgetMs - (roundStart - started))
      const now = yield* Clock.currentTimeMillis
      const budgetLeftMs = budgetMs - (now - started)
      const verdict = verdictFor(round.progress, Math.round((now - started) / 1000))
      const decision = decideRetry(round, carry, budgetLeftMs, config.minRetryBudgetMs)
      if (decision._tag === "Retry") {
        // Not recorded means the next round must not start: the job is left for redelivery, as for a final verdict.
        if (yield* record(spec, verdict, round.durationMs, round.progress, "retry")) {
          return yield* rounds(spec, started, decision.carry)
        }
        return { verdict, recorded: false }
      }
      // recorded = false means the verdict could not be written down (database trouble): the caller must NOT
      // consider the job done, so the queue delivers the task again.
      const closing = decision._tag === "Exhausted" ? "exhausted" : "settle"
      const recorded = yield* record(spec, verdict, round.durationMs, round.progress, closing)
      return { verdict, recorded }
    })

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
      const started = yield* Clock.currentTimeMillis
      return yield* rounds(record.spec, started, undefined)
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

  return { runTask, abandon }
}
