import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import type { ExecutorTask, TaskId, TaskSpec, Verdict } from "@shoalwork/contracts"
import type { ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Clock, Duration, Effect, Exit, Option, Ref } from "effect"
import { chooseExecutor } from "./choose.js"
import { makeConsume } from "./consume.js"
import { deliverCode } from "./git-delivery.js"
import { makeLifecycle } from "./lifecycle.js"
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
  // config/model-tiers.yaml (or its defaults): decides which executor serves each task tier.
  readonly tiers: TierConfig
  readonly config: LeadConfig
}

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
      const chosen = yield* chooseExecutor(tiers, bot, spec.tier, executors)
      if (Option.isNone(chosen)) {
        const message = `no executor available for tier ${spec.tier}`
        yield* raiseError(spec, "lead.executor", "NoExecutor", message)
        yield* Ref.update(progress, withOutcome({ _tag: "NoExecutor", tier: spec.tier }))
        return
      }
      // The model and effort the tier table (or the Bot override) resolved travel in the task: the adapter's argv
      // uses them, and executor.started reports the same model.
      const { executor, model, effort } = chosen.value
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
        model,
        ...(effort === undefined ? {} : { effort }),
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

  return { runTask, abandon }
}
