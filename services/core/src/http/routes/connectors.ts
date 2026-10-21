import { Beacon } from "@shoalwork/beacon"
import {
  type BotFileExists,
  type BotFileMissing,
  BotRegistry,
  type BotWriteError,
  replaceBotYaml,
  restoreBotYaml,
} from "@shoalwork/bots"
import { type BotId, NewBot, NotFound, type SchemaViolation } from "@shoalwork/contracts"
import {
  githubConnector,
  McpRegistry,
  type McpServer,
  type McpServerForBot,
  NewMcpServer,
  notionConnector,
} from "@shoalwork/currents"
import { Effect, Schema, Stream, Struct } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Hono } from "hono"
import {
  buildCatalog,
  type CatalogBot,
  type ConnectorView,
  grants,
  type NativeConnectorSpec,
  recentUsage,
  type UsageRow,
  usageKeyOf,
  usageRowOf,
} from "../../connectors-catalog.js"
import {
  failureResponse,
  type RouteFailure,
  type RouteResponse,
  type RunEffect,
  sendResponse,
} from "./respond.js"

// The native connectors of the product: the ones whose tools and risks are declared in code (T-084, T-087).
const NATIVE: ReadonlyArray<NativeConnectorSpec> = [
  { id: githubConnector.id, name: "GitHub", permissions: githubConnector.permissions },
  { id: notionConnector.id, name: "Notion", permissions: notionConnector.permissions },
]

// The usage of the last 30 days counts; a connector's usage list keeps the 50 most recent calls.
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const USAGE_LIMIT = 50
const USAGE_TYPES = ["mcp.called", "notion.tool_called"] as const

const AssignBody = Schema.Struct({ bots: Schema.Array(Schema.String) })

type FileError = BotFileExists | BotFileMissing | BotWriteError
type Services = BotRegistry | McpRegistry | Beacon
type Program = Effect.Effect<RouteResponse, RouteFailure | FileError, Services>

const conflict = (reason: string): RouteResponse => ({ status: 409, body: { error: "conflict", reason } })

// A refused yaml write is an answer about the file; a failed write of the file itself is a server error.
const fileFailure = (error: FileError): Effect.Effect<RouteResponse> => {
  switch (error._tag) {
    case "BotWriteError":
      return Effect.logError("connectors: yaml write failed", error.message).pipe(
        Effect.as({ status: 500, body: { error: "internal error" } } satisfies RouteResponse),
      )
    case "BotFileExists":
      return Effect.succeed(conflict("bot file already exists"))
    case "BotFileMissing":
      return Effect.succeed(conflict("bot has no definition file to edit"))
  }
}

const respond = (program: Program): Effect.Effect<RouteResponse, never, Services> =>
  program.pipe(
    Effect.catchTags({
      BotFileExists: fileFailure,
      BotFileMissing: fileFailure,
      BotWriteError: fileFailure,
    }),
    Effect.catch(failureResponse),
  )

// Connector calls of the last 30 days, from the log (mcp.called, notion.tool_called).
const loadUsage: Effect.Effect<ReadonlyArray<UsageRow>, SqlError, Beacon> = Effect.gen(function* () {
  const now = Date.now()
  const events = yield* (yield* Beacon)
    .readRange(USAGE_TYPES, { since: now - USAGE_WINDOW_MS, until: now + 1 })
    .pipe(Stream.runCollect)
  return Array.from(events).flatMap((event) => {
    const row = usageRowOf(event)
    return row === undefined ? [] : [row]
  })
})

// Every native connector and every MCP server, with the Bots that use each one and the recent usage.
const loadCatalog: Effect.Effect<ReadonlyArray<ConnectorView>, SqlError, Services> = Effect.gen(function* () {
  const registry = yield* McpRegistry
  const bots = yield* (yield* BotRegistry).list()
  const catalogBots: ReadonlyArray<CatalogBot> = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    connectors: bot.connectors,
  }))
  const access = new Map<string, ReadonlyArray<McpServerForBot>>()
  for (const bot of catalogBots) {
    access.set(bot.id, yield* registry.forBot(bot.id))
  }
  const servers = yield* registry.list()
  const usage = yield* loadUsage
  return buildCatalog({ natives: NATIVE, bots: catalogBots, servers, access, usage })
})

const listConnectors = Effect.gen(function* () {
  const connectors = yield* loadCatalog
  return { status: 200, body: { connectors } } satisfies RouteResponse
})

// The MCP server goes through the same registry as /mcp-servers: one write path. Secrets come as Vault key names only.
const addMcpConnector = (raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(NewMcpServer)(raw)
    const server: McpServer = yield* (yield* McpRegistry).upsert(body)
    return { status: 201, body: { server } } satisfies RouteResponse
  })

type Target =
  | { readonly kind: "native"; readonly id: string }
  | { readonly kind: "mcp"; readonly server: McpServer }

const resolveTarget = (id: string): Effect.Effect<Target, NotFound | SqlError, McpRegistry> =>
  Effect.gen(function* () {
    const native = NATIVE.find((spec) => spec.id === id)
    if (native !== undefined) return { kind: "native", id: native.id }
    const server = (yield* (yield* McpRegistry).list()).find((entry) => entry.id === id)
    if (server !== undefined) return { kind: "mcp", server }
    return yield* Effect.fail(new NotFound({ entity: "Connector", id }))
  })

// Bots named by id or name; an unknown one is a 404, not silently skipped.
const resolveBots = (
  refs: ReadonlyArray<string>,
  bots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>,
): Effect.Effect<ReadonlyArray<BotId>, NotFound> =>
  Effect.forEach(refs, (ref) => {
    const found = bots.find((bot) => bot.id === ref || bot.name === ref)
    return found === undefined
      ? Effect.fail(new NotFound({ entity: "Bot", id: ref }))
      : Effect.succeed(found.id)
  })

// A native connector lives in bot.connectors and in the yaml file: the same write as PATCH /bots/:id (yaml first).
const setNative = (
  id: string,
  wanted: ReadonlySet<string>,
  botsDir: string,
): Effect.Effect<void, RouteFailure | FileError, BotRegistry> =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    for (const summary of yield* registry.list()) {
      const held: ReadonlyArray<string> = summary.connectors
      if (held.includes(id) === wanted.has(summary.id)) continue
      const current = yield* registry.get(summary.id)
      const connectors: ReadonlyArray<string> = wanted.has(summary.id)
        ? [...held, id]
        : held.filter((connector) => connector !== id)
      const next = yield* Schema.decodeUnknownEffect(NewBot)({ ...Struct.omit(current, ["id"]), connectors })
      const previous = yield* replaceBotYaml(botsDir, next)
      yield* registry
        .update(summary.id, next, "api")
        .pipe(Effect.tapError(() => restoreBotYaml(botsDir, next.name, previous).pipe(Effect.ignore)))
    }
  })

// An MCP server is granted to a Bot with every tool ("*") and taken away with an empty list. A Bot that already holds
// a grant keeps its own tool list.
const setMcp = (
  serverId: string,
  bots: ReadonlyArray<{ readonly id: BotId }>,
  wanted: ReadonlySet<string>,
): Effect.Effect<void, NotFound | SchemaViolation | SqlError, McpRegistry> =>
  Effect.gen(function* () {
    const registry = yield* McpRegistry
    for (const bot of bots) {
      const granted = (yield* registry.forBot(bot.id)).find((entry) => entry.id === serverId)?.allowedTools
      const has = granted !== undefined && grants(granted)
      if (wanted.has(bot.id) && !has) yield* registry.allow(bot.id, serverId, "*")
      if (!wanted.has(bot.id) && has) yield* registry.allow(bot.id, serverId, [])
    }
  })

const assignBots = (rawId: string, raw: unknown, botsDir: string | undefined): Program =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(AssignBody)(raw)
    const target = yield* resolveTarget(rawId)
    const bots = yield* (yield* BotRegistry).list()
    const wanted = new Set<string>(yield* resolveBots(body.bots, bots))
    if (target.kind === "native") {
      if (botsDir === undefined) return conflict("bot files are not writable here")
      yield* setNative(target.id, wanted, botsDir)
    } else {
      yield* setMcp(target.server.id, bots, wanted)
    }
    const connectorId = target.kind === "native" ? target.id : target.server.id
    const connector = (yield* loadCatalog).find((view) => view.id === connectorId)
    return { status: 200, body: { connector } } satisfies RouteResponse
  })

const usageOf = (rawId: string): Program =>
  Effect.gen(function* () {
    const target = yield* resolveTarget(rawId)
    const key =
      target.kind === "native" ? usageKeyOf(target.id, undefined) : usageKeyOf(undefined, target.server.name)
    const usage = recentUsage(yield* loadUsage, key, USAGE_LIMIT)
    return { status: 200, body: { usage } } satisfies RouteResponse
  })

export const registerConnectorRoutes = (app: Hono, run: RunEffect, botsDir: string | undefined): void => {
  app.get("/connectors", async (c) => sendResponse(c, await run(respond(listConnectors))))
  app.post("/connectors/mcp", async (c) =>
    sendResponse(c, await run(respond(addMcpConnector(await c.req.json().catch(() => null))))),
  )
  app.patch("/connectors/:id/bots", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await run(respond(assignBots(c.req.param("id"), raw, botsDir))))
  })
  app.get("/connectors/:id/usage", async (c) =>
    sendResponse(c, await run(respond(usageOf(c.req.param("id"))))),
  )
}
