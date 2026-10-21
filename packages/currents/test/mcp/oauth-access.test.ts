import { it } from "@effect/vitest"
import { BeaconLive } from "@shoalwork/beacon"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Redacted } from "effect"
import { describe, expect } from "vitest"
import {
  type McpAuthNeeded,
  type McpOAuthStore,
  McpRegistry,
  McpRegistryLive,
  makeMemoryOAuthStore,
} from "../../src/mcp/index.js"
import { gateSaying } from "./support.js"

const MCP_URL = "https://srv.example/mcp"
const REDIRECT = "https://core.example/oauth/mcp/callback"
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// Same OAuth world as oauth.test.ts; the token endpoint answers a refresh with access-2 and counts what it was asked.
const makeFetch = () => {
  const tokenGrants: Array<string> = []
  const fetchLike = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
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
    if (url === "https://auth.example/token") {
      tokenGrants.push(String(init?.body ?? ""))
      return json({ access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2" })
    }
    return new Response("not found", { status: 404 })
  }
  return { fetchLike, tokenGrants }
}

const remote = { name: "remote", transport: "http" as const, url: MCP_URL, auth: { kind: "oauth" as const } }

const harness = () => {
  const store = makeMemoryOAuthStore()
  const needed: Array<McpAuthNeeded> = []
  const fetched = makeFetch()
  const layer = McpRegistryLive({
    secretsOf: () => ({ get: () => Effect.succeed(Redacted.make("unused")) }),
    gate: gateSaying("allow").gate,
    fetch: fetched.fetchLike,
    oauth: { store, redirectUrl: REDIRECT, notify: (n) => Effect.sync(() => void needed.push(n)) },
  }).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
  return { store, needed, layer, ...fetched }
}

const saveTokens = (store: McpOAuthStore, serverId: string, refresh: boolean) =>
  Effect.promise(() =>
    store.set(serverId, {
      tokens: JSON.stringify({
        access_token: "access-1",
        token_type: "Bearer",
        ...(refresh ? { refresh_token: "refresh-1" } : {}),
      }),
      clientInfo: JSON.stringify({ client_id: "client-1", redirect_uris: [REDIRECT] }),
    }),
  )

const tokenText = (token: Redacted.Redacted<string> | undefined): string | undefined =>
  token === undefined ? undefined : Redacted.value(token)

describe("McpRegistry.accessToken", () => {
  it.live("returns a saved token that has no refresh token as it is, with no request", () => {
    const h = harness()
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      yield* saveTokens(h.store, server.id, false)
      expect(tokenText(yield* registry.accessToken("remote"))).toBe("access-1")
      expect(h.tokenGrants).toEqual([])
      expect(h.needed).toEqual([])
    }).pipe(Effect.provide(h.layer))
  })

  it.live("renews a token that has a refresh token and keeps the new one in the store", () => {
    const h = harness()
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(remote)
      yield* saveTokens(h.store, server.id, true)
      expect(tokenText(yield* registry.accessToken(server.id))).toBe("access-2")
      expect(h.tokenGrants[0]).toContain("grant_type=refresh_token")
      expect(JSON.parse((yield* Effect.promise(() => h.store.get(server.id))).tokens ?? "{}")).toMatchObject({
        access_token: "access-2",
      })
    }).pipe(Effect.provide(h.layer))
  })

  it.live(
    "with no tokens sends one authorization link and gives no token; a link already pending is not sent again",
    () => {
      const h = harness()
      return Effect.gen(function* () {
        const registry = yield* McpRegistry
        yield* registry.upsert(remote)
        expect(yield* registry.accessToken("remote")).toBeUndefined()
        expect(h.needed).toHaveLength(1)
        expect(h.needed[0]?.server).toBe("remote")
        expect(new URL(h.needed[0]?.authorizationUrl ?? "").searchParams.get("code_challenge_method")).toBe(
          "S256",
        )
        expect(yield* registry.accessToken("remote")).toBeUndefined()
        expect(h.needed).toHaveLength(1)
      }).pipe(Effect.provide(h.layer))
    },
  )

  it.live("parallel runs of one server start one authorization, not one each", () => {
    const h = harness()
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      yield* registry.upsert(remote)
      const all = yield* Effect.all(
        [1, 2, 3, 4].map(() => registry.accessToken("remote")),
        { concurrency: "unbounded" },
      )
      expect(all.every((token) => token === undefined)).toBe(true)
      expect(h.needed).toHaveLength(1)
    }).pipe(Effect.provide(h.layer))
  })

  it.live(
    "an Unauthorized connect already sent the link: the run's token request does not send another",
    () => {
      const h = harness()
      return Effect.gen(function* () {
        const registry = yield* McpRegistry
        const server = yield* registry.upsert(remote)
        const error = yield* Effect.flip(registry.test(server.id))
        expect(error).toMatchObject({ reason: "auth_required" })
        expect(h.needed).toHaveLength(1)
        expect(yield* registry.accessToken("remote")).toBeUndefined()
        expect(h.needed).toHaveLength(1)
      }).pipe(Effect.provide(h.layer))
    },
  )

  it.live("a server that is not oauth, or unknown, has no token", () => {
    const h = harness()
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      yield* registry.upsert({ ...remote, name: "open", auth: { kind: "none" } })
      expect(yield* registry.accessToken("open")).toBeUndefined()
      expect(yield* registry.accessToken("nope")).toBeUndefined()
    }).pipe(Effect.provide(h.layer))
  })
})
