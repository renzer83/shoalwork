import { randomUUID } from "node:crypto"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import {
  type BotId,
  NotFound,
  type PolicyDecision,
  PolicyDenied,
  SchemaViolation,
  streamIds,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type McpClientDeps, withMcpSession } from "./client.js"
import { makeOAuthProvider } from "./oauth.js"
import { makeOAuthFlow } from "./oauth-flow.js"
import type { McpRegistryOptions, McpRegistryShape } from "./registry-types.js"
import { type BotServerRow, decodeAllowed, decodeServer, type ServerRow } from "./rows.js"
import {
  AllowedTools,
  McpError,
  type McpServer,
  type McpServerForBot,
  NewMcpServer,
  qualifiedToolName,
  toolAllowed,
} from "./types.js"

export class McpRegistry extends Context.Service<McpRegistry, McpRegistryShape>()("@shoalwork/McpRegistry") {}

// Arguments are a JSON object (or nothing). Anything else never reaches a server.
const argumentsOf = (args: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (args === undefined) return {}
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined
  return Object.fromEntries(Object.entries(args))
}

const dbFailure = (op: string): McpError =>
  new McpError({ server: "", op, reason: "call", message: "registry database error" })

export const makeMcpRegistry = (
  sql: SqlClient,
  beacon: BeaconShape,
  opts: McpRegistryOptions,
): McpRegistryShape => {
  const record = (
    streamId: string,
    type: "mcp.called" | "mcp.server_changed",
    payload: unknown,
    actor: string,
  ) =>
    // The event is the record of something that already happened (the tool ran, the row is written): a failed append is
    // logged, never turned into a failure of the call.
    beacon.append({ streamId, type, payload, actor, correlationId: randomUUID() }).pipe(
      Effect.asVoid,
      Effect.catchCause(() => Effect.logWarning(`mcp: could not record ${type}`)),
    )

  const now = opts.now ?? Date.now

  const oauthFor = (server: McpServer) =>
    opts.oauth === undefined || server.transport !== "http"
      ? undefined
      : makeOAuthProvider({
          serverId: server.id,
          serverName: server.name,
          redirectUrl: opts.oauth.redirectUrl,
          store: opts.oauth.store,
          onAuthorizationUrl: () => undefined,
          now,
          ...(opts.oauth.clientMetadataUrl === undefined
            ? {}
            : { clientMetadataUrl: opts.oauth.clientMetadataUrl }),
          ...(server.auth.kind === "oauth" && server.auth.scope !== undefined
            ? { scope: server.auth.scope }
            : {}),
        })

  const depsFor = (botId: BotId | undefined): McpClientDeps => ({
    secrets: opts.secretsOf(botId),
    ...(opts.oauth === undefined
      ? {}
      : {
          oauthFor: (server: McpServer) => {
            const provider = oauthFor(server)
            if (provider === undefined) throw new Error("oauth is not available for this server")
            return provider
          },
        }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.transportFor === undefined ? {} : { transportFor: opts.transportFor }),
  })

  // Runs `use` against the server; an authorization request is sent to the user before the error goes on.
  const session = <A>(
    server: McpServer,
    botId: BotId | undefined,
    use: Parameters<typeof withMcpSession<A, McpError, never>>[2],
  ) =>
    flow.pendingLink(server).pipe(
      Effect.flatMap((link) =>
        link === undefined
          ? withMcpSession(server, depsFor(botId), use).pipe(
              Effect.tapError((error) =>
                error.reason === "auth_required" &&
                error.authorizationUrl !== undefined &&
                opts.oauth !== undefined
                  ? opts.oauth.notify({ server: server.name, authorizationUrl: error.authorizationUrl })
                  : Effect.void,
              ),
            )
          : // A link is already out and its state is still valid: say so again, without a new flow or a new message.
            Effect.fail(
              new McpError({
                server: server.name,
                op: "connect",
                reason: "auth_required",
                message: "the server needs authorization",
                authorizationUrl: link,
              }),
            ),
      ),
    )

  const byRef = (ref: string): Effect.Effect<McpServer | undefined, SqlError> =>
    sql<ServerRow>`SELECT * FROM mcp_servers WHERE id = ${ref} OR name = ${ref} LIMIT 1`.pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(undefined) : decodeServer(rows[0]))),
    )

  const flow = makeOAuthFlow(opts, { byRef, oauthFor, now })

  const requireServer = (ref: string): Effect.Effect<McpServer, NotFound | SqlError> =>
    byRef(ref).pipe(
      Effect.flatMap((server) =>
        server === undefined
          ? Effect.fail(new NotFound({ entity: "McpServer", id: ref }))
          : Effect.succeed(server),
      ),
    )

  const allowedFor = (botId: BotId, serverId: string): Effect.Effect<AllowedTools | undefined, SqlError> =>
    sql<{ readonly allowed_tools: string }>`SELECT allowed_tools FROM bot_mcp
      WHERE bot_id = ${botId} AND server_id = ${serverId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(undefined) : decodeAllowed(rows[0].allowed_tools),
      ),
    )

  const upsert: McpRegistryShape["upsert"] = (raw) =>
    Effect.gen(function* () {
      const s = yield* Schema.decodeUnknownEffect(NewMcpServer)(raw).pipe(
        Effect.mapError((e) => new SchemaViolation({ where: "mcp_server", issue: e.issue })),
      )
      const stdio = s.transport === "stdio"
      yield* sql`INSERT INTO mcp_servers (id, name, transport, command, args, env_keys, url, auth, enabled, created_at)
        VALUES (${`mcp_${randomUUID()}`}, ${s.name}, ${s.transport}, ${stdio ? s.command : null},
          ${JSON.stringify(stdio ? s.args : [])}, ${JSON.stringify(stdio ? s.envKeys : [])},
          ${stdio ? null : s.url}, ${JSON.stringify(stdio ? { kind: "none" } : s.auth)},
          ${s.enabled === false ? 0 : 1}, ${nowIso()})
        ON CONFLICT (name) DO UPDATE SET transport = excluded.transport, command = excluded.command,
          args = excluded.args, env_keys = excluded.env_keys, url = excluded.url, auth = excluded.auth,
          enabled = excluded.enabled`
      const stored = yield* requireServer(s.name).pipe(Effect.orDie)
      yield* record(
        streamIds.system,
        "mcp.server_changed",
        { action: "upserted", server: s.name },
        "system:mcp",
      )
      return stored
    })

  const list: McpRegistryShape["list"] = () =>
    sql<ServerRow>`SELECT * FROM mcp_servers ORDER BY name`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeServer)),
    )

  const test: McpRegistryShape["test"] = (id, botId) =>
    Effect.gen(function* () {
      const server = yield* requireServer(id)
      const tools = yield* session(server, botId, (s) => s.listTools())
      return { tools }
    })

  const allow: McpRegistryShape["allow"] = (botId, serverRef, tools) =>
    Effect.gen(function* () {
      const checked = yield* Schema.decodeUnknownEffect(AllowedTools)(tools).pipe(
        Effect.mapError((e) => new SchemaViolation({ where: "allowed_tools", issue: e.issue })),
      )
      const server = yield* requireServer(serverRef)
      const bots = yield* sql`SELECT 1 FROM bots WHERE id = ${botId}`
      if (bots.length === 0) return yield* Effect.fail(new NotFound({ entity: "Bot", id: botId }))
      yield* sql`INSERT INTO bot_mcp (bot_id, server_id, allowed_tools) VALUES (${botId}, ${server.id}, ${JSON.stringify(checked)})
        ON CONFLICT (bot_id, server_id) DO UPDATE SET allowed_tools = excluded.allowed_tools`
      yield* record(
        streamIds.bot(botId),
        "mcp.server_changed",
        { action: "allowed", server: server.name, botId },
        "system:mcp",
      )
    })

  const forBot: McpRegistryShape["forBot"] = (botId) =>
    sql<BotServerRow>`SELECT s.*, b.allowed_tools FROM mcp_servers s JOIN bot_mcp b ON b.server_id = s.id
      WHERE b.bot_id = ${botId} AND s.enabled = 1 ORDER BY s.name`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.all({ server: decodeServer(row), allowedTools: decodeAllowed(row.allowed_tools) }).pipe(
            Effect.map(({ server, allowedTools }): McpServerForBot => ({ ...server, allowedTools })),
          ),
        ),
      ),
    )

  const call: McpRegistryShape["call"] = (botId, serverRef, tool, args, options) =>
    Effect.gen(function* () {
      const server = yield* byRef(serverRef).pipe(Effect.mapError(() => dbFailure("call_tool")))
      if (server === undefined) {
        return yield* Effect.fail(
          new McpError({
            server: serverRef,
            op: "call_tool",
            reason: "unknown_server",
            message: "unknown MCP server",
          }),
        )
      }
      const argObject = argumentsOf(args)
      if (argObject === undefined) {
        return yield* Effect.fail(
          new McpError({
            server: server.name,
            op: "call_tool",
            reason: "call",
            message: "tool arguments must be an object",
          }),
        )
      }
      const qualified = qualifiedToolName(server.name, tool)
      const logCall = (decision: PolicyDecision["effect"], ok: boolean, startedAt: number) =>
        Effect.sync(() => Date.now() - startedAt).pipe(
          Effect.flatMap((durationMs) =>
            record(
              streamIds.bot(botId),
              "mcp.called",
              { botId, server: server.name, tool: tool.slice(0, 64), decision, ok, durationMs },
              `bot:${botId}`,
            ),
          ),
        )
      const refuse = (decision: PolicyDecision["effect"]) =>
        logCall(decision, false, Date.now()).pipe(
          Effect.andThen(Effect.fail(new PolicyDenied({ botId, tool: qualified }))),
        )
      const allowed = yield* allowedFor(botId, server.id).pipe(Effect.mapError(() => dbFailure("call_tool")))
      if (!server.enabled || allowed === undefined || !toolAllowed(allowed, tool))
        return yield* refuse("deny")
      if (options?.policyChecked !== true) {
        // MCP tool names are not in the Policy's table: the unknown tool is risk external, which asks by default (T-053).
        const decision = yield* opts.gate.evaluate(botId, { tool: qualified, input: args })
        if (decision.effect !== "allow") return yield* refuse(decision.effect)
      }
      const startedAt = Date.now()
      return yield* session(server, botId, (s) => s.callTool(tool, argObject)).pipe(
        Effect.tap((result) =>
          logCall(
            "allow",
            !(
              typeof result === "object" &&
              result !== null &&
              "isError" in result &&
              result.isError === true
            ),
            startedAt,
          ),
        ),
        Effect.tapError(() => logCall("allow", false, startedAt)),
      )
    })

  return { upsert, list, test, allow, forBot, call, completeOAuth: flow.completeOAuth }
}

export const McpRegistryLive = (
  opts: McpRegistryOptions,
): Layer.Layer<McpRegistry, never, SqlClient | Beacon> =>
  Layer.effect(
    McpRegistry,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      return makeMcpRegistry(sql, beacon, opts)
    }),
  )
