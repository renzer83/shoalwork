import {
  type AuthProvider,
  Client,
  type FetchLike,
  type OAuthClientProvider,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Effect, Redacted } from "effect"
import { MCP_RESULT_MAX_CHARS, McpError, type McpServer, type McpToolInfo } from "./types.js"

export const MCP_TIMEOUT_MS = 60_000
const CLIENT_NAME = "core"
const CLIENT_VERSION = "1.0.0"

// Resolves the Vault keys a server names. The composition root adapts the Vault to this; failures are never shown with
// a value (R7).
export interface McpSecrets {
  readonly get: (key: string) => Effect.Effect<Redacted.Redacted<string>, unknown>
}

export type McpClientDeps = {
  readonly secrets: McpSecrets
  // OAuth provider for a server whose auth is oauth. Absent: such a server cannot be reached.
  readonly oauthFor?: (server: McpServer) => OAuthClientProvider
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  // Test seam: replaces the transport the server would get.
  readonly transportFor?: (server: McpServer) => Transport
}

export interface McpSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<McpToolInfo>, McpError>
  readonly callTool: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, McpError>
}

const fail = (server: McpServer, op: string, reason: McpError["reason"], message: string): McpError =>
  new McpError({ server: server.name, op, reason, message })

// A message that says what failed, never what was sent: the cause can carry argv, env or a token (R7).
const describe = (cause: unknown): string => (cause instanceof Error ? cause.constructor.name : "error")

const classify = (
  server: McpServer,
  op: string,
  cause: unknown,
  authUrl: () => string | undefined,
): McpError => {
  if (UnauthorizedError.isInstance(cause)) {
    const url = authUrl()
    return new McpError({
      server: server.name,
      op,
      reason: "auth_required",
      message: "the server needs authorization",
      ...(url === undefined ? {} : { authorizationUrl: url }),
    })
  }
  if (SdkError.isInstance(cause) && cause.code === SdkErrorCode.RequestTimeout) {
    return fail(server, op, "timeout", "the server did not answer in time")
  }
  return fail(server, op, op === "connect" ? "connect" : "call", `${op} failed (${describe(cause)})`)
}

const secretValue = (server: McpServer, secrets: McpSecrets, key: string): Effect.Effect<string, McpError> =>
  secrets.get(key).pipe(
    Effect.map((value) => Redacted.value(value)),
    Effect.mapError(() => fail(server, "secret", "secret", `secret ${key} could not be read`)),
  )

const buildTransport = (
  server: McpServer,
  deps: McpClientDeps,
  onAuthUrl: (url: string) => void,
): Effect.Effect<Transport, McpError> =>
  Effect.gen(function* () {
    if (deps.transportFor !== undefined) return deps.transportFor(server)
    if (server.transport === "stdio") {
      const env: Record<string, string> = { ...getDefaultEnvironment() }
      for (const key of server.envKeys) env[key] = yield* secretValue(server, deps.secrets, key)
      return new StdioClientTransport({
        command: server.command,
        args: [...server.args],
        env,
        stderr: "ignore",
      })
    }
    const fetchOption = deps.fetch === undefined ? {} : { fetch: deps.fetch }
    const url = new URL(server.url)
    if (server.auth.kind === "oauth") {
      if (deps.oauthFor === undefined)
        return yield* Effect.fail(fail(server, "connect", "connect", "oauth is not configured"))
      const provider = deps.oauthFor(server)
      const wrapped: OAuthClientProvider = {
        ...provider,
        get redirectUrl() {
          return provider.redirectUrl
        },
        get clientMetadata() {
          return provider.clientMetadata
        },
        redirectToAuthorization: async (target) => {
          onAuthUrl(target.toString())
          await provider.redirectToAuthorization(target)
        },
      }
      return new StreamableHTTPClientTransport(url, { authProvider: wrapped, ...fetchOption })
    }
    if (server.auth.kind === "bearer") {
      const token = yield* secretValue(server, deps.secrets, server.auth.tokenKey)
      const bearer: AuthProvider = { token: async () => token }
      return new StreamableHTTPClientTransport(url, { authProvider: bearer, ...fetchOption })
    }
    return new StreamableHTTPClientTransport(url, fetchOption)
  })

const TRUNCATED = "\n[truncated: the server's answer was longer than the limit]"

// Bounds the text a server can hand back (R14: its content is data, and a huge answer is a cost and a risk). Text blocks
// are kept in order until the budget is spent; the rest is dropped and a notice is added.
export const capResult = (result: unknown, max: number = MCP_RESULT_MAX_CHARS): unknown => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return result
  let budget = max
  let cut = false
  const content: Array<unknown> = []
  const blocks: ReadonlyArray<unknown> = result.content
  for (const block of blocks) {
    if (cut) break
    if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
      if (block.text.length <= budget) {
        budget -= block.text.length
        content.push(block)
      } else {
        content.push({ ...block, text: `${block.text.slice(0, budget)}${TRUNCATED}` })
        cut = true
      }
    } else {
      content.push(block)
    }
  }
  return cut ? { ...result, content } : result
}

const toolInfo = (tool: {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined
}): McpToolInfo => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
})

// One connection for the duration of `use`: connect, work, close. The 2026-07-28 protocol is stateless, so a session is
// cheap for HTTP; a stdio server is spawned and ended with it. The process dies with the scope (R: no orphans).
export const withMcpSession = <A, E, R>(
  server: McpServer,
  deps: McpClientDeps,
  use: (session: McpSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpError, R> => {
  const timeout = deps.timeoutMs ?? MCP_TIMEOUT_MS
  let authUrl: string | undefined
  const acquire = Effect.gen(function* () {
    const transport = yield* buildTransport(server, deps, (url) => {
      authUrl = url
    })
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
    yield* Effect.tryPromise({
      try: () => client.connect(transport, { timeout }),
      catch: (cause) => classify(server, "connect", cause, () => authUrl),
    }).pipe(Effect.tapError(() => Effect.promise(() => client.close().catch(() => undefined))))
    return client
  })
  const session = (client: Client): McpSession => ({
    listTools: () =>
      Effect.tryPromise({
        try: () => client.listTools(undefined, { timeout }),
        catch: (cause) => classify(server, "list_tools", cause, () => authUrl),
      }).pipe(Effect.map((result) => result.tools.map(toolInfo))),
    callTool: (tool, args) =>
      Effect.tryPromise({
        try: () => client.callTool({ name: tool, arguments: { ...args } }, { timeout }),
        catch: (cause) => classify(server, "call_tool", cause, () => authUrl),
      }).pipe(Effect.map((result): unknown => capResult(result))),
  })
  return Effect.acquireUseRelease(
    acquire,
    (client) => use(session(client)),
    (client) => Effect.promise(() => client.close().catch(() => undefined)),
  )
}
