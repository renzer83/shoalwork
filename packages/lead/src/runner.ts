import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type TaskId, type TaskSpec, type Verdict, ZERO_USAGE } from "@shoalwork/contracts"
import type { ExecutorContext, ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import type { IndexerShape } from "@shoalwork/reef"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Clock, Effect, Exit, Option, Ref } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { BOT_BUDGET_WINDOW_MS, pauseBotOnBreach, watchBudgets } from "./budget.js"
import { chooseExecutor } from "./choose.js"
import { makeConsume } from "./consume.js"
import type { ContextConfig } from "./context/config.js"
import type { BriefingMemory } from "./context/inject.js"
import type { ControlShape, RunHandle } from "./control.js"
import { makeDeliver } from "./deliver.js"
import { makeLifecycle } from "./lifecycle.js"
import type { McpTokensShape } from "./mcp-tokens.js"
import { recoveredCarry } from "./resume.js"
import { type Carry, decideRetry, MIN_RETRY_BUDGET_MS, type RoundResult } from "./retry.js"
import { watchProcesses } from "./run-processes.js"
import { executorTaskFor, type McpServerConfig, makeRunSetup } from "./run-setup.js"
import { raceWithStop } from "./stoppable.js"
import type { TaskStoreShape } from "./tasks.js"
import {
  blockedVerdict,
  clip,
  describeFailure,
  INITIAL,
  isNotFound,
  isSettled,
  type Progress,
  SUMMARY_MAX,
  stepIdFor,
  stoppedVerdict,
  verdictFor,
  withOutcome,
} from "./verdict.js"

export interface LeadConfig {
  readonly maxTurns: number
  readonly heartbeatMs: number
  // A job whose heartbeat is older than this is considered abandoned and gets requeued by the worker's reaper.
  readonly staleSeconds: number
  readonly reapEveryMs: number
  // Time budget a task must still have left to start another run (retry.ts).
  readonly minRetryBudgetMs: number
  // How long a stop waits for the interrupted runs to finish their cleanup (control.ts).
  readonly stopWaitMs: number
  readonly botBudgetWindowMs: number
  // The reef MCP server a Bot with an indexed repo gets (T-168). Without it no run is given MCP.
  readonly mcp?: McpServerConfig
  // config/context.yaml, read once by the composition root (T-041).
  readonly context?: ContextConfig
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  maxTurns: 50,
  heartbeatMs: 30_000,
  staleSeconds: 120,
  reapEveryMs: 60_000,
  minRetryBudgetMs: MIN_RETRY_BUDGET_MS,
  stopWaitMs: 30_000,
  botBudgetWindowMs: BOT_BUDGET_WINDOW_MS,
}

export interface RunResult {
  readonly verdict: Verdict
  readonly recorded: boolean
  // The task was stopped on purpose: its job is closed as failed, not completed.
  readonly stopped: boolean
}

export interface RunnerDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  readonly tank: TankShape
  readonly executors: typeof ExecutorRegistry.Service
  // config/model-tiers.yaml (or its defaults): decides which executor serves each task tier.
  readonly tiers: TierConfig
  readonly config: LeadConfig
  // Registers every run so that a stop can reach it.
  readonly control: Pick<ControlShape, "track" | "pause">
  readonly memory?: BriefingMemory | undefined
  // Token store of the reef MCP server (T-168): one token per execution, revoked when it ends.
  readonly tokens: McpTokensShape
  // The repo index, when the composition root has one (the briefing reads code from it).
  readonly indexer?: IndexerShape | undefined
}

// Retries run inside the same runTask call, so the job's lock and heartbeat cover them and the task's time budget
// is spent once for all rounds. Each run records one executor.finished; only the last one settles the task.
export const makeRunner = (deps: RunnerDeps) => {
  const { sql, beacon, tasks, bots, tank, executors, tiers, config, control } = deps
  const { taskEvent, raiseError, transition, abandon, cancelUnstarted, record } = makeLifecycle({
    beacon,
    tasks,
    bots,
  })
  const consume = makeConsume({ taskEvent, raiseError, tank })
  const deliver = makeDeliver({ tank, raiseError })
  const setup = makeRunSetup({
    sql,
    bots,
    tank,
    tokens: deps.tokens,
    mcp: config.mcp,
    memory: deps.memory,
    raiseError,
    indexer: deps.indexer,
    context: config.context,
    recordAssembled: (spec, payload) => taskEvent(spec.id, "context.assembled", payload),
  })
  // One executor run, from transition to running until the worktree is released. A retry (carry) continues the
  // previous run's step: same worktree and branch, and the executor session when there is one.
  // Resolves with the context when the run reached its end; never fails: problems become the progress outcome.
  const execute = (
    spec: TaskSpec,
    progress: Ref.Ref<Progress>,
    carry: Carry | undefined,
    budgetLeftMs: number,
    handle: RunHandle,
  ) =>
    Effect.gen(function* () {
      // A resume that failed and runs fresh is the same attempt: only real attempts use up the limit.
      yield* transition(spec, "running", { bumpAttempts: carry?.fallback !== true })
      const { attempts } = yield* tasks.get(spec.id)
      const stepId = carry?.stepId ?? stepIdFor(spec.id, attempts)
      yield* Ref.update(progress, (p) => ({ ...p, stepId, attempt: attempts }))
      yield* setup.markWorking(spec)
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
      const task = executorTaskFor({
        spec,
        botId: bot.id,
        carry,
        stepId,
        model,
        effort,
        maxTurns: config.maxTurns,
      })
      const watch = yield* watchBudgets({ beacon, bot, spec, carry, windowMs: config.botBudgetWindowMs })
      const use = (ctx: TankContext, context: ExecutorContext) =>
        Effect.gen(function* () {
          // The process groups of this run are written down so that a restart can kill the ones it leaves behind.
          yield* Effect.forkScoped(watchProcesses(sql, spec.id, ctx.cwd))
          yield* taskEvent(spec.id, "executor.started", {
            taskId: spec.id,
            stepId,
            botId: bot.id,
            executor: executor.id,
            model,
            cwd: ctx.cwd,
          })
          const delivered = yield* setup.inject(ctx, { spec, bot, task, executor: executor.id })
          yield* consume(
            spec,
            bot,
            executor.id,
            executor.run(delivered, context),
            stepId,
            progress,
            model,
            watch,
          )
          yield* deliver(spec, ctx, progress)
        }).pipe(Effect.scoped, Effect.as(ctx))
      // The whole bracket (MCP grant, Tank context, release, token revoke) lives in run-setup.ts.
      const run = setup.acquire(
        { spec, bot, executorId: executor.id, budgetLeftMs, stepId, reuse: carry?.worktree, progress },
        use,
      )
      // A stop interrupts the run: its finalizers (Tank processes, worktree release) finish before this resolves.
      return yield* raceWithStop(run, handle, budgetLeftMs, progress, watch.breached)
    })

  // One run of the task, with what its verdict and the retry decision need. Never fails.
  const runRound = (
    spec: TaskSpec,
    carry: Carry | undefined,
    budgetLeftMs: number,
    handle: RunHandle,
  ): Effect.Effect<RoundResult> =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>({ ...INITIAL, usage: carry?.usage ?? ZERO_USAGE })
      const started = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(execute(spec, progress, carry, budgetLeftMs, handle))
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

  // Rounds until a verdict is final. A round that ends in a retryable failure records its executor.finished and leaves
  // the task running; the next round starts from its carry. Only the last round settles the task.
  const rounds = (
    spec: TaskSpec,
    started: number,
    carry: Carry | undefined,
    handle: RunHandle,
  ): Effect.Effect<RunResult> =>
    Effect.gen(function* () {
      // A stop asked before a run starts (or between two rounds) ends the task without another run.
      if (yield* handle.isStopped) {
        const by = yield* handle.stopRequested
        const recorded = yield* cancelUnstarted(spec, by).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(false),
          ),
        )
        return { verdict: stoppedVerdict(by), recorded, stopped: true }
      }
      const budgetMs = spec.budget.seconds * 1000
      const roundStart = yield* Clock.currentTimeMillis
      const round = yield* runRound(spec, carry, budgetMs - (roundStart - started), handle)
      const now = yield* Clock.currentTimeMillis
      const budgetLeftMs = budgetMs - (now - started)
      const verdict = verdictFor(round.progress, Math.round((now - started) / 1000))
      const decision = decideRetry(round, carry, budgetLeftMs, config.minRetryBudgetMs)
      if (decision._tag === "Retry") {
        // Not recorded means the next round must not start: the job is left for redelivery, as for a final verdict.
        if (yield* record(spec, verdict, round.durationMs, round.progress, "retry")) {
          return yield* rounds(spec, started, decision.carry, handle)
        }
        return { verdict, recorded: false, stopped: false }
      }
      // recorded = false means the verdict could not be written down (database trouble): the caller must NOT
      // consider the job done, so the queue delivers the task again.
      const closing = decision._tag === "Exhausted" ? "exhausted" : "settle"
      const recorded = yield* record(spec, verdict, round.durationMs, round.progress, closing)
      yield* pauseBotOnBreach(control, spec, round.progress.outcome, raiseError)
      return { verdict, recorded, stopped: round.progress.outcome._tag === "Stopped" }
    })

  const runTask = (id: TaskId): Effect.Effect<RunResult> =>
    Effect.scoped(
      Effect.gen(function* () {
        const record = yield* tasks.get(id)
        // A job delivered twice (reaped lock, retry of the queue entry) must not run the task again.
        if (isSettled(record.state)) {
          return {
            verdict: record.verdict ?? blockedVerdict(`task is ${record.state}`, "settled"),
            recorded: true,
            stopped: false,
          }
        }
        // Registered for as long as the scope lives: a stop finds the run, and waits for it to leave.
        const handle = yield* control.track(id, record.spec.botId)
        // The task may have been stopped between the claim and now: a cancelled task is never run again.
        const current = yield* tasks.get(id)
        if (isSettled(current.state)) {
          return {
            verdict: current.verdict ?? blockedVerdict(`task is ${current.state}`, "settled"),
            recorded: true,
            stopped: false,
          }
        }
        const started = yield* Clock.currentTimeMillis
        const carry = yield* recoveredCarry({ tank, bots }, current)
        return yield* rounds(record.spec, started, carry, handle)
      }),
    ).pipe(
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
            stopped: false,
          }),
        )
      }),
    )

  return { runTask, abandon }
}
