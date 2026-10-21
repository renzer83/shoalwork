import { fileURLToPath } from "node:url"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { NewBot } from "@shoalwork/contracts"
import { type McpAuthNeeded, McpRegistry, McpRegistryLive, makeMemoryOAuthStore } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
const FAKE_SERVER = fileURLToPath(
  new URL("../../../packages/currents/test/mcp/fake-server.mjs", import.meta.url),
)

const layer = Layer.mergeAll(
  McpRegistryLive({
    secretsOf: () => ({ get: () => Effect.fail(new Error("no secrets in this test")) }),
    gate: { evaluate: () => Effect.succeed({ effect: "allow", risk: "external" }) },
    timeoutMs: 20_000,
  }),
  BotRegistryLive,
).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const runtime = ManagedRuntime.make(layer)
afterAll(() => runtime.dispose())

const runMcpServers = <A, E>(eff: Effect.Effect<A, E, McpRegistry>): Promise<A> => runtime.runPromise(eff)
const runEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect, runMcpServers })

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) })

const bot = Schema.decodeUnknownSync(NewBot)({
  name: "dev",
  role: "test",
  instructions: "test bot",
  kind: "fixed",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 60, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "test" },
  memory: { scope: "global" },
})

const ServerList = Schema.Struct({ servers: Schema.Array(Schema.Struct({ id: Schema.String })) })
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })

const fake = { name: "fake", transport: "stdio", command: process.execPath, args: [FAKE_SERVER], envKeys: [] }

describe("MCP registry routes", () => {
  it("require the API token", async () => {
    expect((await app.request("/mcp-servers")).status).toBe(401)
  })

  it("registers a server, lists it and rejects an invalid one", async () => {
    const created = await post("/mcp-servers", fake)
    expect(created.status).toBe(201)
    const listed = await app.request("/mcp-servers", { headers: AUTH })
    expect(await listed.json()).toMatchObject({
      servers: [{ name: "fake", transport: "stdio", enabled: true }],
    })
    expect((await post("/mcp-servers", { name: "bad name", transport: "stdio" })).status).toBe(400)
  })

  it("tests a server by listing its tools, and answers 502 when the process cannot start", async () => {
    const listed = Schema.decodeUnknownSync(ServerList)(
      await (await app.request("/mcp-servers", { headers: AUTH })).json(),
    )
    const id = listed.servers[0]?.id ?? ""
    const tested = await post(`/mcp-servers/${id}/test`, {})
    expect(tested.status).toBe(200)
    const body = Schema.decodeUnknownSync(ToolList)(await tested.json())
    expect(body.tools.map((tool) => tool.name).sort()).toEqual(["echo", "fail", "secret_len"])

    await post("/mcp-servers", { ...fake, name: "broken", command: "/nonexistent/binary", args: [] })
    const broken = await post("/mcp-servers/broken/test", {})
    expect(broken.status).toBe(502)
    expect(await broken.json()).toMatchObject({
      error: "mcp server failed",
      server: "broken",
      reason: "connect",
    })
    expect((await post("/mcp-servers/unknown/test", {})).status).toBe(404)
  })

  it("allows a server for a Bot and refuses an unknown server or a malformed Bot id", async () => {
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BotRegistry).upsert(bot, "test")
      }),
    )
    expect((await post(`/bots/${stored.id}/mcp`, { server: "fake", tools: ["echo"] })).status).toBe(200)
    const mine = await runMcpServers(
      Effect.gen(function* () {
        return yield* (yield* McpRegistry).forBot(stored.id)
      }),
    )
    expect(mine.map((server) => [server.name, server.allowedTools])).toEqual([["fake", ["echo"]]])
    expect((await post(`/bots/${stored.id}/mcp`, { server: "nope", tools: "*" })).status).toBe(404)
    expect((await post("/bots/not-an-id/mcp", { server: "fake", tools: "*" })).status).toBe(404)
    expect((await post(`/bots/${stored.id}/mcp`, { server: "fake" })).status).toBe(400)
  })

  it("answers 400 to an OAuth callback without code and state", async () => {
    expect((await app.request("/oauth/mcp/callback", { headers: AUTH })).status).toBe(400)
  })

  it("refuses a tool name that smuggles a second tool (400) and stores nothing", async () => {
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BotRegistry).upsert(bot, "test")
      }),
    )
    expect((await post(`/bots/${stored.id}/mcp`, { server: "fake", tools: ["echo", "x,Bash"] })).status).toBe(
      400,
    )
    expect((await post(`/bots/${stored.id}/mcp`, { server: "fake", tools: ["Bash(git push)"] })).status).toBe(
      400,
    )
  })
})

// The OAuth callback is open to the browser: the one-time state is its credential, not the API token.
const MCP_URL = "https://srv.example/mcp"
const REDIRECT = "https://core.example/oauth/mcp/callback"
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const oauthFetch = async (input: string | URL): Promise<Response> => {
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
      code_challenge_methods_supported: ["S256"],
    })
  if (url === "https://auth.example/register")
    return json({ client_id: "client-1", redirect_uris: [REDIRECT] }, 201)
  if (url === "https://auth.example/token")
    return json({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 })
  return new Response("not found", { status: 404 })
}

describe("OAuth callback without the API token", () => {
  const needed: Array<McpAuthNeeded> = []
  let clock = Date.parse("2026-10-21T12:00:00Z")
  const oauthRuntime = ManagedRuntime.make(
    McpRegistryLive({
      secretsOf: () => ({ get: () => Effect.fail(new Error("none")) }),
      gate: { evaluate: () => Effect.succeed({ effect: "allow", risk: "external" }) },
      fetch: oauthFetch,
      now: () => clock,
      oauth: {
        store: makeMemoryOAuthStore(),
        redirectUrl: REDIRECT,
        notify: (n) => Effect.sync(() => void needed.push(n)),
      },
    }).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb()))),
  )
  afterAll(() => oauthRuntime.dispose())
  const oauthApp = makeApp({
    apiToken: Redacted.make(TOKEN),
    runEffect,
    runMcpServers: <A, E>(eff: Effect.Effect<A, E, McpRegistry>) => oauthRuntime.runPromise(eff),
  })
  const start = async () => {
    const created = await oauthApp.request("/mcp-servers", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "remote", transport: "http", url: MCP_URL, auth: { kind: "oauth" } }),
    })
    const { server } = Schema.decodeUnknownSync(
      Schema.Struct({ server: Schema.Struct({ id: Schema.String }) }),
    )(await created.json())
    const tested = await oauthApp.request(`/mcp-servers/${server.id}/test`, {
      method: "POST",
      headers: AUTH,
      body: "{}",
    })
    expect(tested.status).toBe(409)
    return new URL(needed.at(-1)?.authorizationUrl ?? "").searchParams.get("state") ?? ""
  }

  it("redeems the code with only the state, then refuses the same state again", async () => {
    const state = await start()
    expect(state).not.toBe("")
    const first = await oauthApp.request(`/oauth/mcp/callback?code=the-code&state=${state}`)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, server: "remote" })
    const again = await oauthApp.request(`/oauth/mcp/callback?code=the-code&state=${state}`)
    expect(again.status).toBe(400)
  })

  it("refuses an expired state and a forged one", async () => {
    const stale = await start()
    clock += 11 * 60 * 1000
    expect((await oauthApp.request(`/oauth/mcp/callback?code=c&state=${stale}`)).status).toBe(400)
    expect((await oauthApp.request("/oauth/mcp/callback?code=c&state=forged")).status).toBe(400)
  })

  it("keeps every other route behind the API token", async () => {
    expect((await oauthApp.request("/mcp-servers")).status).toBe(401)
    expect((await oauthApp.request("/oauth/mcp/callback", { method: "POST" })).status).toBe(401)
  })
})
