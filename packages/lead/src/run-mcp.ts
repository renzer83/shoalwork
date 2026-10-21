import { type Bot, type ExecutorId, repoKeyOf, type TaskSpec } from "@shoalwork/contracts"
import { MCP_NAME_PATTERN, MCP_TOKEN_ENV } from "@shoalwork/executors"
import { Effect, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { BotMcpGrant, BotMcpShape } from "./bot-mcp.js"
import { PermissionBridgeUnavailable } from "./executor-task.js"
import { type IssuedMcpToken, MAX_MCP_TOKEN_TTL_MS, type McpTokensShape } from "./mcp-tokens.js"
import type { McpGrant, McpServerConfig } from "./run-setup.js"

export interface RunMcpDeps {
  readonly sql: SqlClient
  readonly tokens: McpTokensShape
  readonly mcp: McpServerConfig | undefined
  readonly botMcp?: BotMcpShape | undefined
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
  readonly report: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    cause: unknown,
  ) => Effect.Effect<void>
  readonly revokeTask: (spec: TaskSpec) => Effect.Effect<void>
}

// Only the executors whose adapters know how to write the reef server into their config (mcp-config.ts).
const MCP_EXECUTORS: ReadonlySet<string> = new Set(["claude-code", "codex"])

const IndexedRows = Schema.Array(Schema.Struct({ n: Schema.Number }))

const hasIndexedChunks = (sql: SqlClient, repo: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT 1 AS n FROM code_chunks WHERE repo = ${repo} LIMIT 1`
    return (yield* Schema.decodeUnknownEffect(IndexedRows)(rows)).length > 0
  })

export const makeWithMcp = (deps: RunMcpDeps) => {
  const { report, revokeTask } = deps
  // The Bot's own servers, resolved by the core. A failure is reported and the run goes on without them.
  const resolveBotMcp = (spec: TaskSpec, bot: Bot) =>
    deps.botMcp === undefined
      ? Effect.succeed(undefined)
      : deps.botMcp
          .resolve(bot, spec)
          .pipe(
            Effect.catchCause(() =>
              deps
                .raiseError(spec, "lead.mcp", "BotMcpFailed", "the Bot's MCP servers could not be resolved")
                .pipe(Effect.as(undefined)),
            ),
          )

  // A run with no reef server (no repo, nothing indexed, no token) still gets the Bot's own servers.
  const botOnly = (server: McpServerConfig | undefined, bot: Bot, extra: BotMcpGrant | undefined) =>
    extra === undefined || extra.servers.length === 0 || !MCP_NAME_PATTERN.test(bot.id)
      ? undefined
      : ({
          extraEnv: {},
          secretEnv: extra.secretEnv,
          attachment: {
            // Not written anywhere when the reef is off (validateAttachment skips them); the types still ask for them.
            serverEntry: server?.serverEntry ?? "/unused",
            repo: "none",
            bot: bot.id,
            api: server?.api ?? "http://127.0.0.1",
            servers: extra.servers,
            reef: "off",
          },
        } satisfies McpGrant)

  // Runs `use` with this execution's MCP grant: the reef server when the run can have it (a repo, an executor that takes it,
  // time left, names inside the MCP allowlist, indexed chunks or the bridge, a token that could be issued) plus the Bot's own
  // servers. Otherwise only the Bot's servers, or none. The token exists only inside `use`.
  const withMcp = <A, E, R>(
    spec: TaskSpec,
    bot: Bot,
    executorId: ExecutorId,
    budgetLeftMs: number,
    use: (grant: McpGrant | undefined) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PermissionBridgeUnavailable, R> => {
    const server = deps.mcp
    if (!MCP_EXECUTORS.has(executorId) || budgetLeftMs < 1) return use(undefined)
    return resolveBotMcp(spec, bot).pipe(
      Effect.flatMap((extra) =>
        // Without the reef server configured the Bot's own servers still go to the run.
        server === undefined
          ? use(botOnly(undefined, bot, extra))
          : withReef(spec, bot, executorId, budgetLeftMs, server, extra, use),
      ),
    )
  }

  const withReef = <A, E, R>(
    spec: TaskSpec,
    bot: Bot,
    executorId: ExecutorId,
    budgetLeftMs: number,
    server: McpServerConfig,
    extra: BotMcpGrant | undefined,
    use: (grant: McpGrant | undefined) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PermissionBridgeUnavailable, R> => {
    const without = botOnly(server, bot, extra)
    if (spec.repo === undefined) return use(without)
    const repo = repoKeyOf(spec.repo.url)
    const bridge = executorId === "claude-code" ? server.permissionBridge : undefined
    if (!MCP_NAME_PATTERN.test(repo) || !MCP_NAME_PATTERN.test(bot.id)) {
      return deps
        .raiseError(spec, "lead.mcp", "McpScopeRefused", "repo or bot id is outside the MCP name allowlist")
        .pipe(Effect.andThen(use(without)))
    }
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const indexed = yield* hasIndexedChunks(deps.sql, repo).pipe(
          Effect.catch((cause) => report(spec, "lead.mcp", cause).pipe(Effect.as(false))),
        )
        // The bridge needs the token and the config file even when the repo has nothing indexed.
        if (!indexed && bridge === undefined) return yield* restore(use(without))
        // The issue is not interruptible: once the row exists, the revoke below is always attached to it.
        const issued = yield* deps.tokens
          .issue({
            botId: bot.id,
            repo,
            taskId: spec.id,
            ttl: Math.max(1, Math.min(Math.floor(budgetLeftMs), MAX_MCP_TOKEN_TTL_MS)),
            ...(bridge === undefined ? {} : { bridgeMode: bridge.mode }),
          })
          .pipe(
            Effect.map((token): IssuedMcpToken | undefined => token),
            Effect.catch((cause) =>
              report(spec, "lead.mcp", cause).pipe(
                Effect.andThen(
                  bridge === undefined
                    ? Effect.succeed<IssuedMcpToken | undefined>(undefined)
                    : Effect.fail(new PermissionBridgeUnavailable({ step: "token" })),
                ),
              ),
            ),
          )
        if (issued === undefined) return yield* restore(use(without))
        const grant: McpGrant = {
          extraEnv: { [MCP_TOKEN_ENV]: Redacted.value(issued.token) },
          ...(extra === undefined ? {} : { secretEnv: extra.secretEnv }),
          attachment: {
            serverEntry: server.serverEntry,
            repo,
            bot: bot.id,
            api: server.api,
            ...(extra === undefined ? {} : { servers: extra.servers }),
            ...(bridge === undefined ? {} : { permissionBridge: bridge }),
          },
        }
        return yield* restore(use(grant)).pipe(Effect.ensuring(revokeTask(spec)))
      }),
    )
  }

  return withMcp
}
