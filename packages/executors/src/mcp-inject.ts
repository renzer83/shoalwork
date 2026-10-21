// MCP servers a Bot was given (T-083), as the CLIs take them. Pure: servers in, config text out. The files hold names
// of env vars only; the core puts the values in the process env of the run (never in the file, argv or a log).

export interface McpInject {
  // Server name: no underscores, so `mcp__<name>__<tool>` splits back.
  readonly name: string
  readonly transport: "stdio" | "http"
  readonly command?: string
  readonly args?: ReadonlyArray<string>
  // Env vars the server process needs (stdio). Values come from the Vault, injected by the core.
  readonly envKeys?: ReadonlyArray<string>
  readonly url?: string
  // Env var that holds the bearer token for an http server (Vault key or the OAuth access token).
  readonly bearerEnv?: string
  // The tools the Bot may call. An empty list means the server is not injected at all.
  readonly allowedTools: ReadonlyArray<string> | "*"
  // Every tool the server offers (from listTools, filled by the composition). With an explicit allowedTools list, the
  // others are denied to the CLI; without it the CLI cannot be told which ones to deny (see mcpDeniedTools).
  readonly knownTools?: ReadonlyArray<string>
}

// Same rule as the registry: no commas, spaces or parentheses in a tool name that lands in a CLI list.
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/

// `${` is how the CLI expands env references: a value that carries it could pull in a variable we did not name.
const hasExpansion = (text: string | undefined): boolean => (text ?? "").includes("${")

export const isInjectable = (server: McpInject): boolean =>
  NAME.test(server.name) &&
  !["reef", "permission-bridge"].includes(server.name.toLowerCase()) &&
  (server.envKeys ?? []).every((key) => ENV.test(key)) &&
  (server.bearerEnv === undefined || ENV.test(server.bearerEnv)) &&
  (server.allowedTools === "*"
    ? true
    : server.allowedTools.length > 0 && server.allowedTools.every((tool) => TOOL.test(tool))) &&
  (server.knownTools ?? []).every((tool) => TOOL.test(tool)) &&
  !hasExpansion(server.command) &&
  !(server.args ?? []).some(hasExpansion) &&
  !hasExpansion(server.url) &&
  (server.transport === "stdio" ? (server.command ?? "") !== "" : /^https?:\/\//.test(server.url ?? ""))

// Entries of `mcpServers` in the Claude Code --mcp-config document. `${VAR}` is expanded by the CLI at launch.
export const claudeServerEntries = (servers: ReadonlyArray<McpInject>): Record<string, unknown> =>
  Object.fromEntries(
    servers.filter(isInjectable).map((server) => [
      server.name,
      server.transport === "stdio"
        ? {
            command: server.command,
            args: [...(server.args ?? [])],
            env: Object.fromEntries((server.envKeys ?? []).map((key) => [key, `\${${key}}`])),
          }
        : {
            type: "http",
            url: server.url,
            ...(server.bearerEnv === undefined
              ? {}
              : { headers: { Authorization: `Bearer \${${server.bearerEnv}}` } }),
          },
    ]),
  )

// Tools of the Bot's servers the CLI must refuse: what a server offers beyond the Bot's explicit list. MCP tools are NEVER
// pre-approved here (that would skip the Policy and the permission bridge): they ask the Policy like any other call, and
// an allow rule of the Policy reaches the CLI through the Lead's derivation (T-057), exact names only. Without
// `knownTools` an explicit list cannot be turned into denials, so that call still goes to the Policy and its answer.
export const mcpDeniedTools = (servers: ReadonlyArray<McpInject>): ReadonlyArray<string> =>
  servers.filter(isInjectable).flatMap((server) => {
    const allowed = server.allowedTools
    if (allowed === "*") return []
    return (server.knownTools ?? [])
      .filter((tool) => !allowed.includes(tool))
      .map((tool) => `mcp__${server.name}__${tool}`)
  })

// Names of the env vars the run must carry for these servers.
export const mcpEnvNames = (servers: ReadonlyArray<McpInject>): ReadonlyArray<string> => [
  ...new Set(
    servers
      .filter(isInjectable)
      .flatMap((server) => [
        ...(server.envKeys ?? []),
        ...(server.bearerEnv === undefined ? [] : [server.bearerEnv]),
      ]),
  ),
]

export const MANAGED_BEGIN = "# shoalwork-mcp-begin"
export const MANAGED_END = "# shoalwork-mcp-end"

const quote = (text: string): string => JSON.stringify(text)

// Codex filters a server's tools with `enabled_tools`. UNVERIFIED against the CLI docs: 06-research/code-agent-clis.md
// does not list the key (T-166 LIVE confirms it). Absent for "*".
const enabledTools = (server: McpInject): ReadonlyArray<string> =>
  server.allowedTools === "*" ? [] : [`enabled_tools = [${server.allowedTools.map(quote).join(", ")}]`]

// config.toml tables of the Bot's servers, between markers so a later run replaces them whole.
export const codexServerBlock = (servers: ReadonlyArray<McpInject>): string => {
  const tables = servers
    .filter(isInjectable)
    .map((server) =>
      (server.transport === "stdio"
        ? [
            `[mcp_servers.${server.name}]`,
            `command = ${quote(server.command ?? "")}`,
            `args = [${(server.args ?? []).map(quote).join(", ")}]`,
            `env_vars = [${(server.envKeys ?? []).map(quote).join(", ")}]`,
            ...enabledTools(server),
          ]
        : [
            `[mcp_servers.${server.name}]`,
            `url = ${quote(server.url ?? "")}`,
            ...(server.bearerEnv === undefined ? [] : [`bearer_token_env_var = ${quote(server.bearerEnv)}`]),
            "startup_timeout_sec = 10",
            "tool_timeout_sec = 60",
            ...enabledTools(server),
          ]
      ).join("\n"),
    )
  return tables.length === 0 ? "" : `${MANAGED_BEGIN}\n${tables.join("\n\n")}\n${MANAGED_END}\n`
}

// Removes a previous managed region and nothing else.
export const stripManagedServers = (existing: string): string => {
  const begin = existing.lastIndexOf(MANAGED_BEGIN)
  if (begin === -1) return existing
  const end = existing.indexOf(MANAGED_END, begin)
  // A region that never closes is not ours to cut: anything after the marker may be the user's.
  if (end === -1) return existing
  const after = existing.slice(end + MANAGED_END.length).replace(/^\n/, "")
  return `${existing.slice(0, begin).trimEnd()}${after === "" ? "" : `\n\n${after}`}`
}

// Appends the managed region after `text` (idempotent when `text` came from stripManagedServers).
export const withManagedServers = (text: string, block: string): string =>
  block === "" ? text : `${text.trimEnd()}\n\n${block}`
