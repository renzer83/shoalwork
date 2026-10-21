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
import { clearCodexMcp, mcpConfigFor } from "../mcp-config.js"
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
import { type CodexProvider, writeCodexProviderConfig } from "./provider.js"

export const CODEX_ID = Schema.decodeUnknownSync(ExecutorId)("codex")

export type CodexOptions = {
  // Fixed window of the in-memory counter, used only when no `quota` store is injected (T-075 replaces it).
  readonly quotaWindowSeconds: number
  readonly quotaSoftLimitTokens: number
  // Subscription quota store (T-075): usage is recorded and limit errors mark the executor exhausted.
  readonly quota?: QuotaStoreShape
  // Model per tier. A missing tier uses the codex default (no -m: the model of the Bot's config.toml).
  readonly models?: CodexModels
  // Instance id (T-080): codex@ollama and the like. Default "codex".
  readonly id?: ExecutorId
  // Written into the Bot's config.toml before each run (T-080). Absent: the file keeps its own provider.
  readonly provider?: CodexProvider
}

// Observer of the run's events for the in-memory counter: usage only.
const counterObserver =
  (counter: QuotaCounter) =>
  (event: ExecutorEvent): Effect.Effect<void> =>
    event.kind === "usage" ? Effect.sync(() => counter.record(event.usage)) : Effect.void

const spawnFailureOf =
  (executor: ExecutorId) =>
  (cause: unknown): ExecutorSpawnError =>
    new ExecutorSpawnError({ executor, cause })

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

const one = (event: ExecutorEvent): Stream.Stream<ExecutorEvent> => Stream.make(event)

const runCodex = (
  id: ExecutorId,
  task: ExecutorTask,
  ctx: ExecutorContext,
  observe: (event: ExecutorEvent) => Effect.Effect<void>,
  target: (tier: ExecutorTask["tier"]) => CodexTarget,
  provider: CodexProvider | undefined,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tank = yield* Tank
      const spawnFailure = spawnFailureOf(id)
      // The provider table (T-080) first: the MCP merge below keeps every table it does not own.
      if (provider !== undefined) {
        yield* writeCodexProviderConfig(ctx, provider).pipe(Effect.mapError(spawnFailure))
      }
      // Merges the reef table into the Bot's CODEX_HOME/config.toml before codex starts (T-042).
      // Without an attachment the servers of an earlier run are removed (a revoked or refused server must not start).
      yield* (ctx.mcp === undefined ? clearCodexMcp(ctx) : mcpConfigFor("codex", ctx)).pipe(
        Effect.mapError(spawnFailure),
      )
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
  const id = options.id ?? CODEX_ID
  const counter = makeQuotaCounter(id, options.quotaWindowSeconds, options.quotaSoftLimitTokens)
  const mapTier = makeMapTier(options.models)
  const observe = options.quota === undefined ? counterObserver(counter) : observeQuota(options.quota, id)
  return {
    id,
    mapTier,
    quota: () =>
      options.quota === undefined ? Effect.sync(() => counter.status()) : quotaStatusOf(options.quota, id),
    run: (task, ctx) => runCodex(id, task, ctx, observe, mapTier, options.provider),
  }
}
