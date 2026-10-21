import { BotId, NotFound } from "@shoalwork/contracts"
import { AllowedTools, type McpError, McpRegistry, NewMcpServer } from "@shoalwork/currents"
import { Effect, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteFailure, type RouteStatus } from "./respond.js"

// The MCP registry is not part of AppServices (the composition root provides it separately), so these routes run
// their programs through their own runner, like the memory routes.
export type RunMcpServers = {
  bivarianceHack<A, E>(eff: Effect.Effect<A, E, McpRegistry>): Promise<A>
}["bivarianceHack"]

interface McpRouteResponse {
  readonly status: RouteStatus | 502
  readonly body: unknown
}

export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback"

const TestBody = Schema.Struct({ bot: Schema.optionalKey(BotId) })
const AllowBody = Schema.Struct({
  server: Schema.String.check(Schema.isMinLength(1)),
  // Each tool name is checked (no commas, spaces or parentheses): it ends up in CLI lists.
  tools: AllowedTools,
})

// A server that cannot be reached is a bad gateway for the caller; one that needs authorization says where to go.
const mcpFailure = (error: McpError): Effect.Effect<McpRouteResponse> =>
  Effect.succeed(
    error.reason === "oauth_state"
      ? { status: 400, body: { error: "invalid request", where: "state" } }
      : error.reason === "auth_required"
        ? {
            status: 409,
            body: {
              error: "authorization required",
              server: error.server,
              ...(error.authorizationUrl === undefined ? {} : { authorizationUrl: error.authorizationUrl }),
            },
          }
        : error.reason === "unknown_server"
          ? { status: 404, body: { error: "not found", entity: "McpServer", id: error.server } }
          : { status: 502, body: { error: "mcp server failed", server: error.server, reason: error.reason } },
  )

const settle = (
  program: Effect.Effect<McpRouteResponse, McpError | RouteFailure, McpRegistry>,
): Effect.Effect<McpRouteResponse, never, McpRegistry> =>
  program.pipe(Effect.catchTag("McpError", mcpFailure), Effect.catch(failureResponse))

const decodeBotId = (raw: string) =>
  Schema.decodeUnknownEffect(BotId)(raw).pipe(Effect.mapError(() => new NotFound({ entity: "Bot", id: raw })))

const listServers = Effect.gen(function* () {
  const servers = yield* (yield* McpRegistry).list()
  return { status: 200, body: { servers } } satisfies McpRouteResponse
})

const upsertServer = (raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(NewMcpServer)(raw)
    const server = yield* (yield* McpRegistry).upsert(body)
    return { status: 201, body: { server } } satisfies McpRouteResponse
  })

const testServer = (id: string, raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(TestBody)(raw ?? {})
    const result = yield* (yield* McpRegistry).test(id, body.bot)
    return { status: 200, body: result } satisfies McpRouteResponse
  })

const allowForBot = (rawBot: string, raw: unknown) =>
  Effect.gen(function* () {
    const botId = yield* decodeBotId(rawBot)
    const body = yield* Schema.decodeUnknownEffect(AllowBody)(raw)
    yield* (yield* McpRegistry).allow(botId, body.server, body.tools)
    return { status: 200, body: { ok: true } } satisfies McpRouteResponse
  })

// The authorization server sends the browser here. The code is redeemed once; the page body carries no token.
const oauthCallback = (query: {
  readonly code: string | undefined
  readonly state: string | undefined
  readonly iss: string | undefined
}) =>
  Effect.gen(function* () {
    if (query.code === undefined || query.state === undefined) {
      return { status: 400, body: { error: "invalid request", where: "query" } } satisfies McpRouteResponse
    }
    const done = yield* (yield* McpRegistry).completeOAuth(query.state, query.code, query.iss)
    return { status: 200, body: { ok: true, server: done.server } } satisfies McpRouteResponse
  })

export const registerMcpServerRoutes = (app: Hono, run: RunMcpServers): void => {
  const send = async (
    program: Effect.Effect<McpRouteResponse, McpError | RouteFailure, McpRegistry>,
    json: (body: unknown, status: RouteStatus | 502) => Response,
  ) => {
    const result = await run(settle(program))
    return json(result.body, result.status)
  }
  app.get("/mcp-servers", (c) => send(listServers, (b, s) => c.json(b, s)))
  app.post("/mcp-servers", async (c) =>
    send(upsertServer(await c.req.json().catch(() => null)), (b, s) => c.json(b, s)),
  )
  app.post("/mcp-servers/:id/test", async (c) =>
    send(testServer(c.req.param("id"), await c.req.json().catch(() => ({}))), (b, s) => c.json(b, s)),
  )
  app.post("/bots/:id/mcp", async (c) =>
    send(allowForBot(c.req.param("id"), await c.req.json().catch(() => null)), (b, s) => c.json(b, s)),
  )
  app.get(MCP_OAUTH_CALLBACK_PATH, (c) =>
    send(
      oauthCallback({ code: c.req.query("code"), state: c.req.query("state"), iss: c.req.query("iss") }),
      (b, s) => c.json(b, s),
    ),
  )
}
