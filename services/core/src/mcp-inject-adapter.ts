import type { McpServerForBot } from "@shoalwork/currents"
import type { McpInject } from "@shoalwork/executors"

// McpServerForBot (the registry's view of a Bot's server) -> McpInject (what the CLI config needs). Pure. The composition
// root (T-185) lists the tools of each server (`knownTools`), reads the env values and puts them in the run's process
// env; this module only names things.

// Env var that carries the OAuth access token of an http server. The core refreshes the token and sets the value.
export const oauthEnvName = (serverName: string): string =>
  `MCP_OAUTH_${serverName.toUpperCase().replaceAll("-", "_")}`

export const toMcpInject = (
  server: McpServerForBot,
  knownTools?: ReadonlyArray<string>,
): McpInject | undefined => {
  // A Bot with an empty list has no access: the server is not given to the CLI at all.
  if (server.allowedTools !== "*" && server.allowedTools.length === 0) return undefined
  const common = {
    name: server.name,
    allowedTools: server.allowedTools,
    ...(knownTools === undefined ? {} : { knownTools }),
  }
  if (server.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: server.command,
      args: server.args,
      envKeys: server.envKeys,
    }
  }
  const bearerEnv =
    server.auth.kind === "bearer"
      ? server.auth.tokenKey
      : server.auth.kind === "oauth"
        ? oauthEnvName(server.name)
        : undefined
  return { ...common, transport: "http", url: server.url, ...(bearerEnv === undefined ? {} : { bearerEnv }) }
}

export const toMcpInjects = (
  servers: ReadonlyArray<McpServerForBot>,
  knownTools: Readonly<Record<string, ReadonlyArray<string>>> = {},
): ReadonlyArray<McpInject> =>
  servers.flatMap((server) => {
    const inject = toMcpInject(server, knownTools[server.name])
    return inject === undefined ? [] : [inject]
  })

// Where the value of each env var comes from: a Vault key (same name as the var) or the OAuth tokens of a server.
export type McpEnvSource =
  | { readonly env: string; readonly vaultKey: string }
  | { readonly env: string; readonly oauthServer: string }

export const mcpEnvSources = (servers: ReadonlyArray<McpServerForBot>): ReadonlyArray<McpEnvSource> =>
  servers.flatMap((server): ReadonlyArray<McpEnvSource> => {
    if (server.allowedTools !== "*" && server.allowedTools.length === 0) return []
    if (server.transport === "stdio") return server.envKeys.map((key) => ({ env: key, vaultKey: key }))
    if (server.auth.kind === "bearer") return [{ env: server.auth.tokenKey, vaultKey: server.auth.tokenKey }]
    if (server.auth.kind === "oauth") return [{ env: oauthEnvName(server.name), oauthServer: server.name }]
    return []
  })
