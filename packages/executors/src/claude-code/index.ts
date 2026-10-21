import {
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  type ModelTier,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { type McpAttachment, mcpConfigFor } from "../mcp-config.js"
import { parseNdjsonLines } from "../ndjson.js"
import { observeQuota } from "../quota/signals.js"
import { type QuotaStoreShape, quotaStatusOf } from "../quota/store.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import { buildArgs, type McpMode, type TierMapping } from "./args.js"
import { dropApiKey } from "./env.js"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "./events.js"

export type ClaudeCodeOptions = {
  readonly bin?: string
  readonly envOverrides?: Readonly<Record<string, string>>
  readonly id?: ExecutorId
  // Subscription quota (T-075). Without it the adapter records nothing and reports unlimited.
  readonly quota?: QuotaStoreShape
  // Default "none": the run ignores the account's claude.ai connectors (see McpMode in args.ts).
  readonly mcp?: McpMode
  // Model and effort per tier. Default: defaultMapTier (config/model-tiers.yaml replaces it, T-026).
  readonly mapTier?: (tier: ModelTier) => TierMapping
  // Default false (T-055): `auto` tasks ask the permission-bridge MCP server instead of the CLI's own auto mode.
  // Stays off until the LIVE probe confirms the tool contract (T-166).
  readonly permissionBridge?: boolean
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

const withoutBridge = (ctx: ExecutorContext, mcp: McpAttachment): ExecutorContext => {
  const { permissionBridge: _off, ...rest } = mcp
  return { ...ctx, mcp: rest }
}

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

export const makeClaudeCode = (opts: ClaudeCodeOptions = {}): Executor => {
  const id = opts.id ?? DEFAULT_ID
  const bin = opts.bin ?? "claude"
  const mcp: McpMode = opts.mcp ?? "none"
  const mapTier = opts.mapTier ?? defaultMapTier
  const bridge = opts.permissionBridge === true
  const envOverrides = dropApiKey(opts.envOverrides ?? {})
  const spawnFailed = (cause: unknown) => new ExecutorSpawnError({ executor: id, cause })

  const run = (
    task: ExecutorTask,
    ctx: ExecutorContext,
  ): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tank = yield* Tank
        const env = dropApiKey({ ...ctx.env, ...envOverrides })
        // The reef MCP config is written once per run, into the Bot's home (T-042). The bridge server joins it only
        // when this adapter has the bridge on.
        const mcpConfigFile =
          ctx.mcp === undefined
            ? undefined
            : yield* mcpConfigFor("claude-code", bridge ? ctx : withoutBridge(ctx, ctx.mcp)).pipe(
                Effect.mapError(spawnFailed),
              )
        const proc = yield* tank
          .spawnStream({ ...ctx, env }, [
            bin,
            ...buildArgs(
              task,
              mapTier,
              mcp,
              mcpConfigFile,
              bridge && ctx.mcp?.permissionBridge !== undefined,
            ),
          ])
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
        // Usage is recorded and limit errors mark the quota; both come after the stream is complete (tail included).
        return events.pipe(Stream.concat(tail), Stream.tap(observeQuota(opts.quota, id)))
      }),
    )

  return {
    id,
    run,
    mapTier,
    quota: () => quotaStatusOf(opts.quota, id),
  }
}
