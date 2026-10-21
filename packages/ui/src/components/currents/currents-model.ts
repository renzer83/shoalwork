import { Risk } from "@shoalwork/contracts"
import { Schema } from "effect"

// The shapes the app reads from /connectors (services/core/src/connectors-catalog.ts): only the fields it shows.
export const ConnectorBot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tools: Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)]),
})

export const ConnectorEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["native", "mcp", "browser"]),
  status: Schema.Literals(["enabled", "disabled"]),
  permissions: Schema.Array(Schema.Struct({ tool: Schema.String, risk: Risk })),
  bots: Schema.Array(ConnectorBot),
  lastUsedAt: Schema.NullOr(Schema.String),
})
export type ConnectorEntry = typeof ConnectorEntry.Type
export type ConnectorKind = ConnectorEntry["kind"]

export const ConnectorList = Schema.Struct({ connectors: Schema.Array(ConnectorEntry) })
export const ConnectorOne = Schema.Struct({ connector: ConnectorEntry })
export const UsageRow = Schema.Struct({
  at: Schema.String,
  botId: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  ok: Schema.Boolean,
})
export type UsageRow = typeof UsageRow.Type
export const UsageList = Schema.Struct({ usage: Schema.Array(UsageRow) })
export const ServerAdded = Schema.Struct({ server: Schema.Unknown })

export const KIND_ORDER: ReadonlyArray<ConnectorKind> = ["native", "mcp", "browser"]
export const KIND_TITLE: Record<ConnectorKind, string> = {
  native: "Native connectors",
  mcp: "MCP servers",
  browser: "Browser",
}
export const KIND_LABEL: Record<ConnectorKind, string> = {
  native: "Native",
  mcp: "MCP server",
  browser: "Browser",
}

// The MCP form's rules: the core checks the same ones (NewMcpServer). An env entry is the NAME of a Vault key (T-064),
// never its value and never a reference such as op:// or ${...}. The message does not echo what was typed.
const SERVER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/
const VAULT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/
const RESERVED_NAMES: ReadonlyArray<string> = ["reef", "permission-bridge"]

export interface McpDraft {
  readonly name: string
  readonly transport: "stdio" | "http"
  readonly command: string
  readonly args: string
  readonly url: string
  readonly envKeys: string
}

export const splitList = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "")

const isSafeUrl = (raw: string): boolean => {
  const url = raw.trim()
  return /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)
}

// Problems the form shows before it sends anything. Empty means the draft may be sent.
export const mcpDraftIssues = (draft: McpDraft): ReadonlyArray<string> => {
  const issues: string[] = []
  const name = draft.name.trim()
  if (!SERVER_NAME.test(name) || RESERVED_NAMES.includes(name.toLowerCase())) {
    issues.push("Name: letters, digits and dashes only, and not reef or permission-bridge")
  }
  if (draft.transport === "stdio" && draft.command.trim() === "") {
    issues.push("Command is required for a local server")
  }
  if (draft.transport === "http" && !isSafeUrl(draft.url)) {
    issues.push("URL must be https (http only for localhost)")
  }
  for (const key of splitList(draft.envKeys)) {
    if (!VAULT_KEY.test(key)) {
      issues.push("An env entry is not a Vault key name: type the name only, e.g. GITHUB_TOKEN")
      break
    }
  }
  return issues
}

// The body POST /connectors/mcp takes. Env entries travel as names only.
export const mcpDraftBody = (draft: McpDraft): Record<string, unknown> =>
  draft.transport === "stdio"
    ? {
        name: draft.name.trim(),
        transport: "stdio",
        command: draft.command.trim(),
        args: splitList(draft.args),
        envKeys: splitList(draft.envKeys),
      }
    : { name: draft.name.trim(), transport: "http", url: draft.url.trim(), auth: { kind: "none" } }
