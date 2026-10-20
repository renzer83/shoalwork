import {
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  type ModelTier,
} from "@shoalwork/contracts"
import { Tank, type TankContext } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import type { Executor } from "../executor.js"
import { parseNdjsonLines } from "../ndjson.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import { buildArgs, type McpMode, type TierMapping } from "./args.js"
import { dropApiKey } from "./env.js"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "./events.js"

export type ClaudeCodeOptions = {
  readonly bin?: string
  readonly envOverrides?: Readonly<Record<string, string>>
  readonly id?: ExecutorId
  // Default "none": the run ignores the account's claude.ai connectors (see McpMode in args.ts).
  readonly mcp?: McpMode
  // Model and effort per tier. Default: defaultMapTier (config/model-tiers.yaml replaces it, T-026).
  readonly mapTier?: (tier: ModelTier) => TierMapping
}

const DEFAULT_ID = Schema.decodeUnknownSync(ExecutorId)("claude-code")

// Default tier table, used when no mapTier is injected. Full model ids: the alias `haiku` routed to Sonnet on CLI
// 2.1.304 (06-research/claude-code.md §10).
export const defaultMapTier = (tier: ModelTier): TierMapping => {
  switch (tier) {
    case "chat":
    case "decision":
      return { model: "claude-haiku-5-5", effort: "low" }
    case "light":
      return { model: "claude-haiku-5-5", effort: "high" }
    case "heavy":
      return { model: "claude-opus-5-5", effort: "high" }
  }
}

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

export const makeClaudeCode = (opts: ClaudeCodeOptions = {}): Executor => {
  const id = opts.id ?? DEFAULT_ID
  const bin = opts.bin ?? "claude"
  const mcp: McpMode = opts.mcp ?? "none"
  const mapTier = opts.mapTier ?? defaultMapTier
  const envOverrides = dropApiKey(opts.envOverrides ?? {})
  const spawnFailed = (cause: unknown) => new ExecutorSpawnError({ executor: id, cause })

  const run = (
    task: ExecutorTask,
    ctx: TankContext,
  ): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tank = yield* Tank
        const env = dropApiKey({ ...ctx.env, ...envOverrides })
        const proc = yield* tank
          .spawnStream({ ...ctx, env }, [bin, ...buildArgs(task, mapTier, mcp)])
          .pipe(Effect.mapError(spawnFailed))
        // The prompt travels in argv. With stdin left open, claude waits 3 s and warns about missing input.
        yield* proc.closeStdin()
        const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailed)))
        // Fresh per run: tool_use ids and the session id only matter inside one stream.
        const state = makeMapperState(id)
        const lines = parseNdjsonLines(ClaudeStreamLine, id)(proc.stdout.pipe(Stream.mapError(spawnFailed)))
        let terminal = false
        const events = lines.pipe(
          Stream.mapEffect((line) =>
            toExecutorEvents(line, state).pipe(
              Effect.tap((mapped) =>
                mapped.length === 0
                  ? Effect.logDebug(`claude-code: ignored line type ${line.type}`)
                  : Effect.void,
              ),
            ),
          ),
          Stream.flatMap((mapped) => Stream.fromIterable(mapped)),
          Stream.tap((event) =>
            Effect.sync(() => {
              if (isTerminal(event)) terminal = true
            }),
          ),
        )
        // stdout ended without done|error: report how the process ended, with the redacted stderr tail.
        const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
          Effect.suspend((): Effect.Effect<Stream.Stream<ExecutorEvent>> => {
            if (terminal) return Effect.succeed(Stream.empty)
            return Effect.map(Effect.all({ code: proc.exitCode, text: stderrTail }), ({ code, text }) =>
              Stream.make(endedWithoutResult("claude", code, text)),
            )
          }),
        )
        return events.pipe(Stream.concat(tail))
      }),
    )

  return {
    id,
    run,
    mapTier,
    // No local counter yet: the soft limit is not decided. Reports unlimited until F5 (real quota).
    quota: () => Effect.succeed({ executor: id, usedRatio: 0, available: true }),
  }
}
