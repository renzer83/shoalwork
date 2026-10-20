import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape } from "@shoalwork/bots"
import {
  BotId,
  type Event,
  EventPayloads,
  type ExecutorEvent,
  type ExecutorId,
  type ExecutorTask,
  newStepId,
  type StepId,
  streamIds,
  TaskId,
  type TaskState,
} from "@shoalwork/contracts"
import { type JobRow, Jobs } from "@shoalwork/db"
import { ExecutorRegistry, type TierConfig } from "@shoalwork/executors"
import {
  ConsolidationModel,
  ConsolidationModelError,
  consolidateTask,
  type Embedder,
  type Reef,
} from "@shoalwork/reef"
import { Tank, type TankShape } from "@shoalwork/tank"
import { Cause, Duration, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { chooseExecutor } from "../choose.js"
import { TaskStore } from "../tasks.js"
import { clip, describeFailure, EVIDENCE_MAX } from "../verdict.js"

export const CONSOLIDATE_QUEUE = "consolidate"
// One retry: the queue delivers the job again after a short backoff, then gives up and records error.raised.
const MAX_ATTEMPTS = 2
// Jobs whose heartbeat is older than this are requeued by the reaper (a crashed process).
const REAP_STALE_SECONDS = 120
const REAP_EVERY_MS = 60_000
// The light run is one turn with no tools: it only answers with the consolidation JSON.
const LIGHT_BUDGET = { tokens: 20_000, seconds: 120, usd: 0.5 }
const LIGHT_MAX_TURNS = 1
const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(["done", "failed", "cancelled"])

const TransitionPayload = EventPayloads["task.state_changed"]
const JobPayload = Schema.Struct({ taskId: TaskId, botId: BotId })
type JobPayload = typeof JobPayload.Type

export interface ConsolidateHookOptions {
  readonly pollMs: number
  readonly heartbeatMs: number
}

interface LightDeps {
  readonly bots: BotRegistryShape
  readonly tank: TankShape
  readonly executors: typeof ExecutorRegistry.Service
  readonly beacon: BeaconShape
}

const recordUsage = (
  beacon: BeaconShape,
  event: Extract<ExecutorEvent, { kind: "usage" }>,
  ids: { readonly taskId: TaskId; readonly stepId: StepId; readonly botId: BotId },
  executor: ExecutorId,
  model: string,
): Effect.Effect<void> =>
  beacon
    .append({
      streamId: streamIds.task(ids.taskId),
      type: "usage.recorded",
      payload: { ...ids, executor, model, usage: event.usage },
      actor: "system:lead",
      correlationId: ids.taskId,
    })
    .pipe(
      Effect.asVoid,
      // Cost bookkeeping must not turn a finished consolidation into a retry (the model would run again).
      Effect.catch((error) => Effect.logWarning("consolidation usage not recorded", error._tag)),
    )

// One light-tier run through the executor the tier table picks. The text of the `done` event is returned as data.
const runLight = (
  tiers: TierConfig,
  deps: LightDeps,
  input: { readonly botId: BotId; readonly taskId: TaskId; readonly prompt: string },
): Effect.Effect<string, ConsolidationModelError> =>
  Effect.gen(function* () {
    const bot = yield* deps.bots.get(input.botId)
    const chosen = yield* chooseExecutor(tiers, bot, "light", deps.executors)
    if (Option.isNone(chosen)) {
      return yield* Effect.fail(
        new ConsolidationModelError({ detail: "no executor available for tier light" }),
      )
    }
    const { executor, model, effort } = chosen.value
    const stepId = newStepId()
    const ctx = yield* deps.tank.prepare(bot, { stepId })
    const task: ExecutorTask = {
      taskId: input.taskId,
      stepId,
      botId: bot.id,
      prompt: input.prompt,
      tier: "light",
      allowedTools: [],
      permissionMode: "readonly",
      maxTurns: LIGHT_MAX_TURNS,
      budget: LIGHT_BUDGET,
      model,
      ...(effort === undefined ? {} : { effort }),
    }
    const release = deps.tank
      .release(ctx, { keepWorktree: false })
      .pipe(Effect.catch((error) => Effect.logWarning("consolidation release failed", error._tag)))
    const events = yield* Stream.runCollect(executor.run(task, ctx)).pipe(
      Effect.ensuring(release),
      Effect.provideService(Tank, deps.tank),
      Effect.scoped,
    )
    let text: string | undefined
    let failure: string | undefined
    for (const event of events) {
      if (event.kind === "usage") {
        yield* recordUsage(
          deps.beacon,
          event,
          { taskId: input.taskId, stepId, botId: bot.id },
          executor.id,
          model,
        )
      } else if (event.kind === "done") {
        text = event.result
      } else if (event.kind === "error") {
        failure = `${event.code}: ${event.message}`
      }
    }
    if (text !== undefined) {
      return text
    }
    return yield* Effect.fail(
      new ConsolidationModelError({
        detail: clip(failure ?? "executor ended without a result", EVIDENCE_MAX),
      }),
    )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ConsolidationModelError
        ? error
        : new ConsolidationModelError({ detail: describeFailure(error).message }),
    ),
  )

// The ConsolidationModel of the Lead: the light tier through the executor registry, in a kept-nothing worktree.
export const executorConsolidationModel = (
  tiers: TierConfig,
): Layer.Layer<ConsolidationModel, never, BotRegistry | Tank | ExecutorRegistry | Beacon> =>
  Layer.effect(
    ConsolidationModel,
    Effect.gen(function* () {
      const deps: LightDeps = {
        bots: yield* BotRegistry,
        tank: yield* Tank,
        executors: yield* ExecutorRegistry,
        beacon: yield* Beacon,
      }
      return { run: (input) => runLight(tiers, deps, input) }
    }),
  )

const logCause = (message: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.logError(message, describeFailure(Cause.squash(cause)).tag)

const decodeJob = (text: string): Option.Option<JobPayload> =>
  Option.flatMap(Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(text), (raw) =>
    Schema.decodeUnknownOption(JobPayload)(raw),
  )

// Subscribes to task transitions into a terminal state and queues one consolidation job per task. Then runs the
// queue: one job at a time, heartbeat while it runs, one retry, error.raised when the retry is also gone.
// Nothing here changes the task: a consolidation failure never turns a done task into a failed one.
export const startConsolidateHook = (
  options: ConsolidateHookOptions,
): Effect.Effect<
  void,
  never,
  Scope.Scope | Beacon | SqlClient | TaskStore | BotRegistry | Reef | Embedder | ConsolidationModel
> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const tasks = yield* TaskStore
    const bots = yield* BotRegistry
    const transitions = yield* beacon.subscribe(["task.state_changed"])

    const queueIfTerminal = (event: Event) =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknownEffect(TransitionPayload)(event.payload).pipe(Effect.orDie)
        if (!TERMINAL.has(payload.to)) {
          return
        }
        const record = yield* tasks.get(payload.taskId)
        yield* Jobs.enqueue(
          CONSOLIDATE_QUEUE,
          { taskId: payload.taskId, botId: record.spec.botId },
          { maxAttempts: MAX_ATTEMPTS },
        )
      }).pipe(Effect.catchCause(logCause("could not queue consolidation")))

    const heartbeat = (job: JobRow) =>
      Effect.forever(
        Effect.sleep(Duration.millis(options.heartbeatMs)).pipe(
          Effect.andThen(Jobs.heartbeat(job.id, job.attempts)),
          Effect.catch((error) => Effect.logWarning("consolidate heartbeat failed", error._tag)),
        ),
      )

    const onFailure = (job: JobRow, payload: JobPayload) => (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            const failure = describeFailure(Cause.squash(cause))
            const message = clip(`${failure.tag}: ${failure.message}`, EVIDENCE_MAX)
            yield* Jobs.fail(job.id, message, job.attempts)
            if (job.attempts >= job.max_attempts) {
              yield* beacon.append({
                streamId: streamIds.task(payload.taskId),
                type: "error.raised",
                payload: {
                  where: "reef.consolidate",
                  tag: failure.tag,
                  message,
                  taskId: payload.taskId,
                  botId: payload.botId,
                },
                actor: "system:lead",
                correlationId: payload.taskId,
              })
            }
          }).pipe(Effect.catchCause(logCause("could not record the consolidation failure")))

    const handle = (job: JobRow) => {
      const parsed = decodeJob(job.payload)
      if (Option.isNone(parsed)) {
        return Jobs.fail(job.id, "invalid job payload", job.attempts).pipe(
          Effect.asVoid,
          Effect.catch((error) => Effect.logWarning("could not fail invalid job", error._tag)),
        )
      }
      const payload = parsed.value
      const work = Effect.gen(function* () {
        const bot = yield* bots.get(payload.botId)
        yield* consolidateTask({
          taskId: payload.taskId,
          botId: payload.botId,
          instructions: bot.instructions,
        })
        yield* Jobs.complete(job.id, job.attempts)
      }).pipe(Effect.catchCause(onFailure(job, payload)))
      return Effect.raceFirst(work, heartbeat(job)).pipe(
        Effect.annotateLogs({ jobId: job.id, taskId: payload.taskId }),
      )
    }

    const claimStep = Effect.gen(function* () {
      const claimed = yield* Jobs.claim(CONSOLIDATE_QUEUE)
      if (Option.isNone(claimed)) {
        yield* Effect.sleep(Duration.millis(options.pollMs))
        return
      }
      yield* handle(claimed.value)
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("consolidate claim failed", error._tag).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(options.pollMs))),
        ),
      ),
    )

    const reapStep = Effect.gen(function* () {
      const reaped = yield* Jobs.reapStale(REAP_STALE_SECONDS, CONSOLIDATE_QUEUE)
      if (reaped.requeued > 0) {
        yield* Effect.logWarning("requeued stale consolidation jobs", reaped.requeued)
      }
      for (const job of reaped.failed) {
        yield* Effect.logWarning("consolidation job abandoned after max attempts", job.id)
      }
      yield* Effect.sleep(Duration.millis(REAP_EVERY_MS))
    }).pipe(Effect.catch((error) => Effect.logWarning("consolidate reap failed", error._tag)))

    yield* Effect.forkScoped(Stream.runForEach(transitions, queueIfTerminal))
    yield* Effect.forkScoped(Effect.forever(claimStep))
    yield* Effect.forkScoped(Effect.forever(reapStep))
  })
