import {
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  type ModelTier,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { Duration, Effect, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { parseNdjsonLines } from "../ndjson.js"
import { makeQuotaCounter, type QuotaCounter } from "../quota.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import {
  buildRunArgs,
  isProviderModel,
  makeMapTier,
  type OpencodeModels,
  type OpencodeTarget,
  permissionFor,
  targetFor,
} from "./args.js"
import { type OpencodeProvider, writeOpencodeConfig } from "./config.js"
import { makeOpencodeMapper, OpencodeLine } from "./events.js"

export const OPENCODE_ID = Schema.decodeUnknownSync(ExecutorId)("opencode")

export type OpencodeOptions = {
  // Model per tier, `provider/model`. Required for every tier: there is no default.
  readonly models: OpencodeModels
  // Providers that need an entry in opencode.json (see config.ts). Default: none, the built-in ones only.
  readonly providers?: ReadonlyArray<OpencodeProvider>
  // Fixed window for the local quota counter; the real subscription quota is F5 work.
  readonly quotaWindowSeconds: number
  readonly quotaSoftLimitTokens: number
}

const spawnFailure = (cause: unknown): ExecutorSpawnError =>
  new ExecutorSpawnError({ executor: "opencode", cause })

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

const one = (event: ExecutorEvent): Stream.Stream<ExecutorEvent> => Stream.make(event)

// A model that is not `provider/model` is a configuration problem. The run's error channel has no config case, so it
// is reported as an error event before any process starts.
const badModel = (target: OpencodeTarget): ExecutorEvent => ({
  kind: "error",
  code: "unknown",
  message: `config: opencode model must be provider/model, got "${target.model}"`,
})

const runOpencode = (
  task: ExecutorTask,
  ctx: ExecutorContext,
  quota: QuotaCounter,
  options: OpencodeOptions,
  target: (tier: ModelTier) => OpencodeTarget,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const resolved = targetFor(task, target)
      if (!isProviderModel(resolved.model)) return one(badModel(resolved))
      const tank = yield* Tank
      // Written before every run, so a readonly rule never outlives the run that asked for it.
      yield* writeOpencodeConfig(ctx, options.providers ?? [], permissionFor(task.permissionMode)).pipe(
        Effect.mapError(spawnFailure),
      )
      const argv = buildRunArgs(task, ctx.cwd, resolved)
      const proc = yield* tank.spawnStream(ctx, ["opencode", ...argv]).pipe(Effect.mapError(spawnFailure))
      // `opencode run` waits for stdin to close before it starts; the prompt is the only input.
      yield* proc.closeStdin()
      const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailure)))

      const mapper = makeOpencodeMapper(task.budget)
      let secondsExpired = false
      // Wall-clock budget: when it fires, the upstream is cut and the process is killed; `tail` reports it.
      const deadline = Effect.sleep(Duration.seconds(task.budget.seconds)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            secondsExpired = true
          }),
        ),
        Effect.andThen(proc.kill()),
      )
      // Runs only when no terminal event came from the stream: budget cut, exit 0 (the last text is the result), or
      // any other exit (carries the redacted stderr tail).
      const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
        Effect.suspend((): Effect.Effect<Stream.Stream<ExecutorEvent>> => {
          if (mapper.finished()) return Effect.succeed(Stream.empty)
          if (secondsExpired) {
            return Effect.succeed(
              one({
                kind: "error",
                code: "budget",
                message: `wall-clock budget of ${task.budget.seconds}s exceeded`,
              }),
            )
          }
          return Effect.map(Effect.all({ code: proc.exitCode, text: stderrTail }), ({ code, text }) =>
            code === 0
              ? Stream.fromIterable(mapper.finish())
              : one(endedWithoutResult("opencode", code, text)),
          )
        }),
      )

      const parse = parseNdjsonLines(OpencodeLine, "opencode")
      return parse(proc.stdout.pipe(Stream.mapError(spawnFailure))).pipe(
        Stream.mapEffect((line) => mapper.push(line)),
        Stream.flatMap((events) => Stream.fromIterable(events)),
        Stream.tap((event) =>
          event.kind === "usage" ? Effect.sync(() => quota.record(event.usage)) : Effect.void,
        ),
        Stream.takeUntil(isTerminal),
        Stream.interruptWhen(deadline),
        Stream.concat(tail),
        // Kills the process when the run ends early (terminal event, budget cut); a no-op after a normal exit.
        Stream.ensuring(proc.kill()),
      )
    }),
  )

export const makeOpencode = (options: OpencodeOptions): Executor => {
  const quota = makeQuotaCounter(OPENCODE_ID, options.quotaWindowSeconds, options.quotaSoftLimitTokens)
  const mapTier = makeMapTier(options.models)
  return {
    id: OPENCODE_ID,
    mapTier,
    quota: () => Effect.sync(() => quota.status()),
    run: (task, ctx) => runOpencode(task, ctx, quota, options, mapTier),
  }
}
