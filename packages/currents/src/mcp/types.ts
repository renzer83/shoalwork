import { Data, Schema } from "effect"

// Server names end up in tool names (`mcp__<server>__<tool>`), config tables and argv: no underscores, no spaces.
// `reef` and `permission-bridge` are the product's own servers in the same config: a user server may not shadow them.
const RESERVED_NAMES: ReadonlyArray<string> = ["reef", "permission-bridge"]
export const McpServerName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/),
).check(
  Schema.makeFilter((name: string) => !RESERVED_NAMES.includes(name.toLowerCase()) || "reserved server name"),
)

// A tool name goes into config files and, in some CLIs, into comma-separated lists: no commas, spaces or parentheses.
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
export const McpToolName = Schema.String.check(Schema.isPattern(MCP_TOOL_NAME))

// A Vault key, which is also the name of the env var the secret is injected as.
export const McpEnvKey = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/))

// Remote servers are https; http is for the local machine only. Link-local addresses (cloud metadata included) are never
// a server. Hostnames that resolve elsewhere are the network's business, not the schema's.
const LOCAL_HOSTS: ReadonlyArray<string> = ["localhost", "127.0.0.1", "[::1]"]
const BLOCKED_HOST = /^(169\.254\.|\[fe80:|\[::ffff:169\.254\.|metadata\.google\.internal$)/i
export const isAllowedServerUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    if (url.username !== "" || url.password !== "") return false
    if (BLOCKED_HOST.test(url.hostname) || BLOCKED_HOST.test(url.host)) return false
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}
const HttpUrl = Schema.String.check(
  Schema.makeFilter((raw: string) => isAllowedServerUrl(raw) || "an https url (http only for localhost)"),
)

// How a remote server is authenticated. `bearer` names a Vault key; `oauth` runs the authorization flow (PKCE).
export const McpAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("bearer"), tokenKey: McpEnvKey }),
  Schema.Struct({ kind: Schema.Literal("oauth"), scope: Schema.optionalKey(Schema.String) }),
])
export type McpAuth = typeof McpAuth.Type

const stdioFields = {
  transport: Schema.Literal("stdio"),
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  envKeys: Schema.Array(McpEnvKey),
}
const httpFields = {
  transport: Schema.Literal("http"),
  url: HttpUrl,
  auth: McpAuth,
}

export const NewMcpServer = Schema.Union([
  Schema.Struct({ name: McpServerName, ...stdioFields, enabled: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ name: McpServerName, ...httpFields, enabled: Schema.optionalKey(Schema.Boolean) }),
])
export type NewMcpServer = typeof NewMcpServer.Type

export const McpServer = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    name: McpServerName,
    ...stdioFields,
    enabled: Schema.Boolean,
    createdAt: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    name: McpServerName,
    ...httpFields,
    enabled: Schema.Boolean,
    createdAt: Schema.String,
  }),
])
export type McpServer = typeof McpServer.Type

// "*" means every tool of the server; otherwise the exact tool names.
export const AllowedTools = Schema.Union([Schema.Literal("*"), Schema.Array(McpToolName)])
export type AllowedTools = typeof AllowedTools.Type

export type McpServerForBot = McpServer & { readonly allowedTools: AllowedTools }

export interface McpToolInfo {
  readonly name: string
  readonly description?: string
  // JSON Schema of the arguments, as the server declares it. Untrusted text (R14): data for the model, never run.
  readonly inputSchema?: Readonly<Record<string, unknown>>
}

export type McpErrorReason =
  | "unknown_server"
  | "disabled"
  | "not_allowed"
  | "connect"
  | "timeout"
  | "call"
  | "secret"
  | "auth_required"
  | "oauth_state"

export class McpError extends Data.TaggedError("McpError")<{
  readonly server: string
  readonly op: string
  readonly reason: McpErrorReason
  readonly message: string
  // Set when reason is auth_required: where the user authorizes. Never holds a token.
  readonly authorizationUrl?: string
}> {}

// Result text of one call is cut here; the model gets a notice instead of the rest.
export const MCP_RESULT_MAX_CHARS = 256 * 1024

export const toolAllowed = (allowed: AllowedTools, tool: string): boolean =>
  allowed === "*" || allowed.includes(tool)

// The name a CLI or a chat-completions model sees for a tool of a server.
export const qualifiedToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

// Splits `mcp__<server>__<tool>`; server names hold no underscores, so the first `__` after the prefix is the cut.
export const parseQualifiedToolName = (
  name: string,
): { readonly server: string; readonly tool: string } | undefined => {
  if (!name.startsWith("mcp__")) return undefined
  const rest = name.slice(5)
  const cut = rest.indexOf("__")
  if (cut <= 0 || cut + 2 >= rest.length) return undefined
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}
