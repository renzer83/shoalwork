import { it } from "@effect/vitest"
import { BeaconLive } from "@shoalwork/beacon"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  type McpAuthNeeded,
  McpRegistry,
  McpRegistryLive,
  makeMemoryOAuthStore,
  makeOAuthProvider,
  makeSqlOAuthStore,
} from "../../src/mcp/index.js"
import { gateSaying } from "./support.js"

const MCP_URL = "https://srv.example/mcp"
const REDIRECT = "https://core.example/oauth/mcp/callback"
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

// An MCP server that wants OAuth, with its resource metadata, authorization server, registration and token endpoint.
const makeFetch = () => {
  const seen: Array<{ url: string; method: string; body: string }> = []
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? "GET"
    seen.push({ url, method, body: typeof init?.body === "string" ? init.body : String(init?.body ?? "") })
    if (url.startsWith(MCP_URL))
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://srv.example/.well-known/oauth-protected-resource/mcp"`,
        },
      })
    if (url.startsWith("https://srv.example/.well-known/oauth-protected-resource"))
      return json({ resource: MCP_URL, authorization_servers: ["https://auth.example"] })
    if (url === "https://auth.example/.well-known/oauth-authorization-server")
      return json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    if (url === "https://auth.example/register")
      return json(
        { client_id: "client-1", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
        201,
      )
    if (url === "https://auth.example/token")
      return json({
        access_token: "access-1",
        token_type: "Bearer",
        refresh_token: "refresh-1",
        expires_in: 3600,
      })
    return new Response("not found", { status: 404 })
  }
  return { fetchLike, seen }
}

const base64Cipher = {
  seal: (plain: string) => `sealed:${Buffer.from(plain).toString("base64")}`,
  open: (sealed: string) => Buffer.from(sealed.slice(7), "base64").toString("utf8"),
}

const remote = {
  name: "remote",
  transport: "http" as const,
  url: MCP_URL,
  auth: { kind: "oauth" as const, scope: "read" },
}

const withRegistry = (
  store: ReturnType<typeof makeMemoryOAuthStore>,
  needed: Array<McpAuthNeeded>,
  now?: () => number,
) => {
  const { fetchLike } = makeFetch()
  return McpRegistryLive({
    secretsOf: () => ({ get: () => Effect.succeed(Redacted.make("unused")) }),
    gate: gateSaying("allow").gate,
    fetch: fetchLike,
    ...(now === undefined ? {} : { now }),
    oauth: {
      store,
      redirectUrl: REDIRECT,
      notify: (n) => Effect.sync(() => void needed.push(n)),
    },
  }).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
}

describe("MCP OAuth", () => {
  it.live(
    "an Unauthorized connect becomes an authorization link sent to the user, with PKCE and the resource",
    () => {
      const store = makeMemoryOAuthStore()
      const needed: Array<McpAuthNeeded> = []
      return Effect.gen(function* () {
        const registry = yield* McpRegistry
        const server = yield* registry.upsert(remote)
        const error = yield* Effect.flip(registry.test(server.id))
        expect(error).toMatchObject({ _tag: "McpError", reason: "auth_required", server: "remote" })
        const authorizationUrl = error._tag === "McpError" ? error.authorizationUrl : undefined
        const link = new URL(authorizationUrl ?? "")
        expect(`${link.origin}${link.pathname}`).toBe("https://auth.example/authorize")
        expect(link.searchParams.get("code_challenge_method")).toBe("S256")
        expect(link.searchParams.get("code_challenge")).not.toBeNull()
        expect(link.searchParams.get("resource")).toBe(MCP_URL)
        expect(link.searchParams.get("client_id")).toBe("client-1")
        expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT)
        expect(needed).toEqual([{ server: "remote", authorizationUrl }])
        expect((yield* Effect.promise(() => store.get(server.id))).codeVerifier).toBeDefined()
      }).pipe(Effect.provide(withRegistry(store, needed)))
    },
  )

  it.live("the callback redeems the code once and keeps the tokens in the store", () => {
    const store = makeMemoryOAuthStore()
    const needed: Array<McpAuthNeeded> = []
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      yield* Effect.flip(registry.test(server.id))
      const state = new URL(needed[0]?.authorizationUrl ?? "").searchParams.get("state") ?? ""
      expect(state).not.toBe("")
      const done = yield* registry.completeOAuth(state, "the-code")
      expect(done).toEqual({ server: "remote" })
      const saved = yield* Effect.promise(() => store.get(server.id))
      expect(JSON.parse(saved.tokens ?? "{}")).toMatchObject({ access_token: "access-1" })
      const replay = yield* Effect.flip(registry.completeOAuth(state, "the-code"))
      expect(replay).toMatchObject({ _tag: "McpError", message: "unknown or expired authorization state" })
    }).pipe(Effect.provide(withRegistry(store, needed)))
  })

  it.live("a callback with an unknown state redeems nothing", () => {
    const store = makeMemoryOAuthStore()
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const error = yield* Effect.flip(registry.completeOAuth("forged", "code"))
      expect(error).toMatchObject({ _tag: "McpError", reason: "oauth_state" })
    }).pipe(Effect.provide(withRegistry(store, [])))
  })
})

describe("OAuth provider and store", () => {
  it("round-trips tokens and client registration through the store", async () => {
    const store = makeMemoryOAuthStore()
    const provider = makeOAuthProvider({
      serverId: "mcp_1",
      serverName: "remote",
      redirectUrl: REDIRECT,
      store,
      onAuthorizationUrl: () => undefined,
    })
    expect(await provider.tokens()).toBeUndefined()
    await provider.saveTokens({ access_token: "a", token_type: "Bearer" })
    await provider.saveClientInformation?.({ client_id: "c" })
    expect(await provider.tokens()).toMatchObject({ access_token: "a" })
    expect(await provider.clientInformation()).toMatchObject({ client_id: "c" })
    expect(provider.clientMetadata.redirect_uris).toEqual([REDIRECT])
    await provider.invalidateCredentials?.("tokens")
    expect(await provider.tokens()).toBeUndefined()
  })

  it.effect("the SQL store keeps tokens sealed, never in clear", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO mcp_servers (id, name, transport, url, auth, created_at)
        VALUES ('mcp_1', 'remote', 'http', ${MCP_URL}, '{"kind":"oauth"}', '2026-10-21T00:00:00.000Z')`
      const store = yield* makeSqlOAuthStore(base64Cipher)
      yield* Effect.promise(() =>
        store.set("mcp_1", { tokens: '{"access_token":"plain-secret"}', state: "s1" }),
      )
      const rows = yield* sql<{
        readonly tokens: string
      }>`SELECT tokens FROM mcp_oauth WHERE server_id = 'mcp_1'`
      expect(rows[0]?.tokens.startsWith("sealed:")).toBe(true)
      expect(rows[0]?.tokens).not.toContain("plain-secret")
      expect((yield* Effect.promise(() => store.get("mcp_1"))).tokens).toContain("plain-secret")
      yield* Effect.promise(() => store.set("mcp_1", { stateIssuedAt: "2026-10-21T10:00:00.000Z" }))
      // Atomic and single use: only the first redemption wins, and an old state wins nothing.
      expect(yield* Effect.promise(() => store.redeemState("s1", "2026-10-21T10:05:00.000Z"))).toBeUndefined()
      expect(yield* Effect.promise(() => store.redeemState("s1", "2026-10-21T09:50:00.000Z"))).toBe("mcp_1")
      expect(yield* Effect.promise(() => store.redeemState("s1", "2026-10-21T09:50:00.000Z"))).toBeUndefined()
      expect((yield* Effect.promise(() => store.get("mcp_1"))).state).toBeUndefined()
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a value that no longer opens counts as no tokens, not as a failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO mcp_servers (id, name, transport, url, auth, created_at)
        VALUES ('mcp_2', 'other', 'http', ${MCP_URL}, '{"kind":"oauth"}', '2026-10-21T00:00:00.000Z')`
      const store = yield* makeSqlOAuthStore(base64Cipher)
      yield* Effect.promise(() => store.set("mcp_2", { tokens: '{"access_token":"a"}' }))
      const rotated = yield* makeSqlOAuthStore({
        seal: base64Cipher.seal,
        open: () => {
          throw new Error("bad key")
        },
      })
      expect((yield* Effect.promise(() => rotated.get("mcp_2"))).tokens).toBeUndefined()
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("MCP OAuth state lifetime", () => {
  const T0 = Date.parse("2026-10-21T12:00:00Z")

  it.live("a state older than 10 minutes redeems nothing, and a new link is issued and sent", () => {
    const store = makeMemoryOAuthStore()
    const needed: Array<McpAuthNeeded> = []
    let clock = T0
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      yield* Effect.flip(registry.test(server.id))
      const first = new URL(needed[0]?.authorizationUrl ?? "").searchParams.get("state") ?? ""
      clock = T0 + 11 * 60 * 1000
      const late = yield* Effect.flip(registry.completeOAuth(first, "code"))
      expect(late).toMatchObject({ _tag: "McpError", reason: "oauth_state" })
      yield* Effect.flip(registry.test(server.id))
      expect(needed).toHaveLength(2)
    }).pipe(Effect.provide(withRegistry(store, needed, () => clock)))
  })

  it.live("a pending link is reused inside the window, without a new flow or a new message", () => {
    const store = makeMemoryOAuthStore()
    const needed: Array<McpAuthNeeded> = []
    let clock = T0
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      const first = yield* Effect.flip(registry.test(server.id))
      clock = T0 + 5 * 60 * 1000
      const again = yield* Effect.flip(registry.test(server.id))
      expect(again).toMatchObject({ reason: "auth_required" })
      expect(again._tag === "McpError" && again.authorizationUrl).toBe(
        first._tag === "McpError" ? first.authorizationUrl : "",
      )
      expect(needed).toHaveLength(1)
    }).pipe(Effect.provide(withRegistry(store, needed, () => clock)))
  })

  it.live("a state works once: the replay is refused with oauth_state", () => {
    const store = makeMemoryOAuthStore()
    const needed: Array<McpAuthNeeded> = []
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      yield* Effect.flip(registry.test(server.id))
      const state = new URL(needed[0]?.authorizationUrl ?? "").searchParams.get("state") ?? ""
      yield* registry.completeOAuth(state, "code")
      const replay = yield* Effect.flip(registry.completeOAuth(state, "code"))
      expect(replay).toMatchObject({ reason: "oauth_state" })
    }).pipe(Effect.provide(withRegistry(store, needed)))
  })
})
