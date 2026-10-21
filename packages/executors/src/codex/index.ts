import {
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { Duration, Effect, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { mcpConfigFor } from "../mcp-config.js"
import { parseNdjsonLines } from "../ndjson.js"
import { observeQuota } from "../quota/signals.js"
import { type QuotaStoreShape, quotaStatusOf } from "../quota/store.js"
import { makeQuotaCounter, type QuotaCounter } from "../quota.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import {
  buildResumeArgs,
  buildRunArgs,
  type CodexModels,
  type CodexTarget,
  makeMapTier,
  targetFor,
} from "./args.js"
import { CodexEvent, makeCodexMapper } from "./events.js"

export const CODEX_ID = Schema.decodeUnknownSync(ExecutorId)("codex")

export type CodexOptions = {
  // Fixed window of the in-memory counter, used only when no `quota` store is injected (T-075 replaces it).
  readonly quotaWindowSeconds: number
  readonly quotaSoftLimitTokens: number
  // Subscription quota store (T-075): usage is recorded and limit errors mark the executor exhausted.
  readonly quota?: QuotaStoreShape
  // Model per tier. A missing tier uses the codex default (no -m: the model of the Bot's config.toml).
  readonly models?: CodexModels
}

// Observer of the run's events for the in-memory counter: usage only.
const counterObserver =
  (counter: QuotaCounter) =>
  (event: ExecutorEvent): Effect.Effect<void> =>
    event.kind === "usage" ? Effect.sync(() => counter.record(event.usage)) : Effect.void

const spawnFailure = (cause: unknown): ExecutorSpawnError =>
  new ExecutorSpawnError({ executor: "codex", cause })

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

const one = (event: ExecutorEvent): Stream.Stream<ExecutorEvent> => Stream.make(event)

const runCodex = (
  task: ExecutorTask,
  ctx: ExecutorContext,
  observe: (event: ExecutorEvent) => Effect.Effect<void>,
  target: (tier: ExecutorTask["tier"]) => CodexTarget,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tank = yield* Tank
      // Merges the reef table into the Bot's CODEX_HOME/config.toml before codex starts (T-042).
      if (ctx.mcp !== undefined) {
        yield* mcpConfigFor("codex", ctx).pipe(Effect.mapError(spawnFailure))
      }
      const argv =
        task.resumeSessionId === undefined
          ? buildRunArgs(task, ctx.cwd, targetFor(task, target))
          : buildResumeArgs(task.resumeSessionId, task.prompt, targetFor(task, target))
      const proc = yield* tank.spawnStream(ctx, ["codex", ...argv]).pipe(Effect.mapError(spawnFailure))
      // codex exec reads extra input from stdin until it closes; the prompt is the only input.
      yield* proc.closeStdin()
      const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailure)))

      const mapper = makeCodexMapper(task.budget)
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
      // Runs only when no terminal event was emitted: budget cut, or the process ended without a result (non-zero
      // exit or silent exit 0). The last case carries the redacted stderr tail, like any other ended-without-result.
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
          return Effect.map(
            Effect.all({ code: proc.exitCode, text: stderrTail }),
            ({ code, text }): Stream.Stream<ExecutorEvent> => one(endedWithoutResult("codex", code, text)),
          )
        }),
      )

      const parse = parseNdjsonLines(CodexEvent, "codex")
      return parse(proc.stdout.pipe(Stream.mapError(spawnFailure))).pipe(
        Stream.flatMap((event) => Stream.fromIterable(mapper.push(event))),
        Stream.takeUntil(isTerminal),
        Stream.interruptWhen(deadline),
        Stream.concat(tail),
        // After the tail so a budget or exit error is observed too; usage is observed before its terminal event.
        Stream.tap(observe),
        // Kills the process when the run ends early (terminal event, budget cut); a no-op after a normal exit.
        Stream.ensuring(proc.kill()),
      )
    }),
  )

export const makeCodexExecutor = (options: CodexOptions): Executor => {
  const counter = makeQuotaCounter(CODEX_ID, options.quotaWindowSeconds, options.quotaSoftLimitTokens)
  const mapTier = makeMapTier(options.models)
  const observe =
    options.quota === undefined ? counterObserver(counter) : observeQuota(options.quota, CODEX_ID)
  return {
    id: CODEX_ID,
    mapTier,
    quota: () =>
      options.quota === undefined
        ? Effect.sync(() => counter.status())
        : quotaStatusOf(options.quota, CODEX_ID),
    run: (task, ctx) => runCodex(task, ctx, observe, mapTier),
  }
}
