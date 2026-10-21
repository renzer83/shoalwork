import type { BotId, Event, Risk } from "@shoalwork/contracts"
import {
  type AllowedTools,
  type McpServer,
  type McpServerForBot,
  qualifiedToolName,
} from "@shoalwork/currents"
import { DateTime, Option, Schema } from "effect"

// The read side of the connectors catalog (GET /connectors). Pure: the routes load the data, this shapes it.

export type ConnectorKind = "native" | "mcp" | "browser"
export type ConnectorStatus = "enabled" | "disabled"

export interface NativeConnectorSpec {
  readonly id: string
  readonly name: string
  readonly permissions: ReadonlyArray<{ readonly tool: string; readonly risk: Risk }>
}

export interface CatalogBot {
  readonly id: BotId
  readonly name: string
  readonly connectors: ReadonlyArray<string>
}

// One use of a connector, from the event log. `key` is the connector's usage key (see usageKeyOf).
export interface UsageRow {
  readonly key: string
  readonly at: string
  readonly botId: string
  readonly tool: string
  readonly decision: "allow" | "ask" | "deny"
  readonly ok: boolean
}

export interface CatalogInput {
  readonly natives: ReadonlyArray<NativeConnectorSpec>
  readonly bots: ReadonlyArray<CatalogBot>
  readonly servers: ReadonlyArray<McpServer>
  // What each Bot may call on each enabled MCP server (McpRegistry.forBot).
  readonly access: ReadonlyMap<string, ReadonlyArray<McpServerForBot>>
  readonly usage: ReadonlyArray<UsageRow>
}

export interface ConnectorBotView {
  readonly id: BotId
  readonly name: string
  readonly tools: AllowedTools
}

export interface ConnectorView {
  readonly id: string
  readonly name: string
  readonly kind: ConnectorKind
  readonly status: ConnectorStatus
  readonly permissions: ReadonlyArray<{ readonly tool: string; readonly risk: Risk }>
  readonly bots: ReadonlyArray<ConnectorBotView>
  readonly lastUsedAt: string | null
}

// Usage keys: a native connector's id, or `mcp:<server name>`. Server names hold no colon, so the two never meet.
export const usageKeyOf = (native: string | undefined, server: string | undefined): string =>
  native !== undefined ? native : `mcp:${server ?? ""}`

// Projections of the event payloads the catalog reads (mcp.called, notion.tool_called). Only the fields used here.
const McpCalled = Schema.Struct({
  botId: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  ok: Schema.Boolean,
})
const NotionCalled = Schema.Struct({
  botId: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  ok: Schema.Boolean,
})

const decodeOrUndefined = <A, I>(schema: Schema.Codec<A, I>, raw: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(raw))

// One event of the log as a usage row; events that are not connector calls, or that do not decode, are left out.
export const usageRowOf = (event: Event): UsageRow | undefined => {
  const at = DateTime.formatIso(event.occurredAt)
  if (event.type === "mcp.called") {
    const call = decodeOrUndefined(McpCalled, event.payload)
    return call === undefined
      ? undefined
      : {
          key: usageKeyOf(undefined, call.server),
          at,
          botId: call.botId,
          tool: qualifiedToolName(call.server, call.tool),
          decision: call.decision,
          ok: call.ok,
        }
  }
  if (event.type === "notion.tool_called") {
    const call = decodeOrUndefined(NotionCalled, event.payload)
    return call === undefined
      ? undefined
      : {
          key: usageKeyOf("notion", undefined),
          at,
          botId: call.botId,
          tool: `notion.${call.tool}`,
          decision: call.decision,
          ok: call.ok,
        }
  }
  return undefined
}

// A grant is any non-empty tool list, or "*". An empty list is a revoked grant.
export const grants = (allowed: AllowedTools): boolean => allowed === "*" || allowed.length > 0

const lastUseOf = (usage: ReadonlyArray<UsageRow>, key: string): string | null =>
  usage.reduce<string | null>((latest, row) => {
    if (row.key !== key) return latest
    return latest === null || row.at > latest ? row.at : latest
  }, null)

const nativeView = (native: NativeConnectorSpec, input: CatalogInput): ConnectorView => ({
  id: native.id,
  name: native.name,
  kind: "native",
  status: "enabled",
  permissions: native.permissions,
  bots: input.bots
    .filter((bot) => bot.connectors.includes(native.id))
    .map((bot) => ({ id: bot.id, name: bot.name, tools: "*" })),
  lastUsedAt: lastUseOf(input.usage, usageKeyOf(native.id, undefined)),
})

// An MCP server's tools are not known until it is asked; every tool it has is external (T-083), so the permissions
// are what the Bots were granted: all of them, or the names they were given.
const mcpView = (server: McpServer, input: CatalogInput): ConnectorView => {
  const bots: Array<ConnectorBotView> = []
  for (const bot of input.bots) {
    const granted = input.access.get(bot.id)?.find((entry) => entry.id === server.id)?.allowedTools
    if (granted !== undefined && grants(granted)) {
      bots.push({ id: bot.id, name: bot.name, tools: granted })
    }
  }
  const names = new Set<string>()
  let all = false
  for (const bot of bots) {
    if (bot.tools === "*") all = true
    else for (const tool of bot.tools) names.add(tool)
  }
  const tools = all ? ["*"] : Array.from(names)
  return {
    id: server.id,
    name: server.name,
    kind: "mcp",
    status: server.enabled ? "enabled" : "disabled",
    permissions: tools.map((tool) => ({ tool, risk: "external" })),
    bots,
    lastUsedAt: lastUseOf(input.usage, usageKeyOf(undefined, server.name)),
  }
}

export const buildCatalog = (input: CatalogInput): ReadonlyArray<ConnectorView> => [
  ...input.natives.map((native) => nativeView(native, input)),
  ...input.servers.map((server) => mcpView(server, input)),
]

// The most recent uses of one connector, newest first.
export const recentUsage = (
  usage: ReadonlyArray<UsageRow>,
  key: string,
  limit: number,
): ReadonlyArray<UsageRow> =>
  usage
    .filter((row) => row.key === key)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
