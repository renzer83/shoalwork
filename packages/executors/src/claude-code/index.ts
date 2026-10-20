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
import { buildArgs, type TierMapping } from "./args.js"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "./events.js"

export type ClaudeCodeOptions = {
  readonly bin?: string
  readonly envOverrides?: Readonly<Record<string, string>>
  readonly id?: ExecutorId
}

const DEFAULT_ID = Schema.decodeUnknownSync(ExecutorId)("claude-code")

// Default tier table; T-026 replaces it with the config file.
export const defaultMapTier = (tier: ModelTier): TierMapping => {
  switch (tier) {
    case "chat":
    case "decision":
      return { model: "haiku", effort: "low" }
    case "light":
      return { model: "haiku", effort: "high" }
    case "heavy":
      return { model: "opus", effort: "high" }
  }
}

// Never reintroduced through envOverrides: the Bot pays through its CLI login, not an API key (ADR-011).
// ANTHROPIC_AUTH_TOKEN stays allowed in overrides: it is how gateways such as Z.ai are reached.
const FORBIDDEN_ENV_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"])

const withoutForbidden = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !FORBIDDEN_ENV_KEYS.has(key)))

export const makeClaudeCode = (opts: ClaudeCodeOptions = {}): Executor => {
  const id = opts.id ?? DEFAULT_ID
  const bin = opts.bin ?? "claude"
  const envOverrides = withoutForbidden(opts.envOverrides ?? {})
  const spawnFailed = (cause: unknown) => new ExecutorSpawnError({ executor: id, cause })

  const run = (
    task: ExecutorTask,
    ctx: TankContext,
  ): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tank = yield* Tank
        const env = withoutForbidden({ ...ctx.env, ...envOverrides })
        const proc = yield* tank
          .spawnStream({ ...ctx, env }, [bin, ...buildArgs(task, defaultMapTier)])
          .pipe(Effect.mapError(spawnFailed))
        // The prompt travels in argv. With stdin left open, claude waits 3 s and warns about missing input.
        yield* proc.closeStdin()
        // Fresh per run: tool_use ids and the session id only matter inside one stream.
        const state = makeMapperState(id)
        const lines = parseNdjsonLines(ClaudeStreamLine, id)(proc.stdout.pipe(Stream.mapError(spawnFailed)))
        return lines.pipe(
          Stream.mapEffect((line) =>
            toExecutorEvents(line, state).pipe(
              Effect.tap((events) =>
                events.length === 0
                  ? Effect.logDebug(`claude-code: ignored line type ${line.type}`)
                  : Effect.void,
              ),
            ),
          ),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        )
      }),
    )

  return {
    id,
    run,
    mapTier: defaultMapTier,
    // No local counter yet: the soft limit is not decided. Reports unlimited until F5 (real quota).
    quota: () => Effect.succeed({ executor: id, usedRatio: 0, available: true }),
  }
}
