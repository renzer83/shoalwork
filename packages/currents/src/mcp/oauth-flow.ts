import type { OAuthClientProvider } from "@modelcontextprotocol/client"
import { auth } from "@modelcontextprotocol/client"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { STATE_TTL_MS } from "./oauth.js"
import type { McpRegistryOptions, McpRegistryShape } from "./registry-types.js"
import { McpError, type McpServer } from "./types.js"

// The OAuth side of the registry: the pending link of a server and the callback that redeems the state.
export const makeOAuthFlow = (
  opts: McpRegistryOptions,
  deps: {
    readonly byRef: (ref: string) => Effect.Effect<McpServer | undefined, SqlError>
    readonly oauthFor: (server: McpServer) => OAuthClientProvider | undefined
    readonly now: () => number
  },
) => {
  const { byRef, oauthFor, now } = deps
  const freshAfter = (): string => new Date(now() - STATE_TTL_MS).toISOString()
  const dbFailure = (op: string): McpError =>
    new McpError({ server: "", op, reason: "call", message: "registry database error" })

  // The link of an authorization still waiting for the user: the server has no tokens and its state has not expired.
  const pendingLink = (server: McpServer): Effect.Effect<string | undefined> => {
    const store = opts.oauth?.store
    if (store === undefined || server.transport !== "http" || server.auth.kind !== "oauth")
      return Effect.succeed(undefined)
    return Effect.promise(() => store.get(server.id)).pipe(
      Effect.map((saved) =>
        saved.tokens === undefined &&
        saved.state !== undefined &&
        saved.stateIssuedAt !== undefined &&
        saved.stateIssuedAt > freshAfter()
          ? saved.authUrl
          : undefined,
      ),
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
  }

  const completeOAuth: McpRegistryShape["completeOAuth"] = (state, code, iss) =>
    Effect.gen(function* () {
      const oauth = opts.oauth
      const fail = (message: string, reason: McpError["reason"] = "auth_required") =>
        Effect.fail(new McpError({ server: "", op: "oauth_callback", reason, message }))
      if (oauth === undefined) return yield* fail("oauth is not configured")
      // The state is the credential of this call: atomic, single use, 10 minutes. A replay or a forged state finds nothing.
      const serverId = yield* Effect.promise(() => oauth.store.redeemState(state, freshAfter()))
      if (serverId === undefined) return yield* fail("unknown or expired authorization state", "oauth_state")
      const server = yield* byRef(serverId).pipe(Effect.mapError(() => dbFailure("oauth_callback")))
      if (server === undefined || server.transport !== "http") return yield* fail("unknown MCP server")
      const provider = oauthFor(server)
      if (provider === undefined) return yield* fail("oauth is not configured")
      yield* Effect.tryPromise({
        try: () =>
          auth(provider, {
            serverUrl: server.url,
            authorizationCode: code,
            ...(iss === undefined ? {} : { iss }),
            ...(opts.fetch === undefined ? {} : { fetchFn: opts.fetch }),
          }),
        catch: () =>
          new McpError({
            server: server.name,
            op: "oauth_callback",
            reason: "auth_required",
            message: "authorization failed",
          }),
      })
      yield* Effect.promise(() => oauth.store.set(serverId, { authUrl: undefined }))
      return { server: server.name }
    })

  return { pendingLink, completeOAuth }
}
