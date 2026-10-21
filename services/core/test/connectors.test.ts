import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive, writeBotYaml } from "@shoalwork/bots"
import { type BotId, NewBot, streamIds } from "@shoalwork/contracts"
import { McpRegistryLive } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const layer = Layer.mergeAll(
  McpRegistryLive({
    secretsOf: () => ({ get: () => Effect.fail(new Error("no secrets in this test")) }),
    gate: { evaluate: () => Effect.succeed({ effect: "allow", risk: "external" }) },
    timeoutMs: 20_000,
  }),
  BotRegistryLive,
).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const runtime = ManagedRuntime.make(layer)

// The bot files live in a temporary directory, so the native assignment writes a real yaml file.
const botsDir = mkdtempSync(join(tmpdir(), "connectors-bots-"))
const runEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect, botsDir })

const newBot = (name: string) =>
  Schema.decodeUnknownSync(NewBot)({
    name,
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

const ConnectorEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  status: Schema.String,
  permissions: Schema.Array(Schema.Struct({ tool: Schema.String, risk: Schema.String })),
  bots: Schema.Array(Schema.Struct({ name: Schema.String, tools: Schema.Unknown })),
  lastUsedAt: Schema.NullOr(Schema.String),
})
const Catalog = Schema.Struct({ connectors: Schema.Array(ConnectorEntry) })
const OneConnector = Schema.Struct({ connector: ConnectorEntry })
const Usage = Schema.Struct({
  usage: Schema.Array(Schema.Struct({ tool: Schema.String, ok: Schema.Boolean, decision: Schema.String })),
})

const fake = {
  name: "fake",
  transport: "stdio",
  command: process.execPath,
  args: ["-e", "0"],
  envKeys: [],
}

const readCatalog = async () =>
  Schema.decodeUnknownSync(Catalog)(await (await app.request("/connectors", { headers: AUTH })).json())

let devId: BotId

beforeAll(async () => {
  const dev = newBot("dev")
  devId = await runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const stored = yield* registry.upsert(dev, "test")
      yield* registry.upsert(newBot("ops"), "test")
      yield* writeBotYaml(botsDir, dev)
      return stored.id
    }).pipe(Effect.orDie),
  )
})

afterAll(async () => {
  await runtime.dispose()
  rmSync(botsDir, { recursive: true, force: true })
})

describe("connectors catalog", () => {
  it("requires the API token", async () => {
    expect((await app.request("/connectors")).status).toBe(401)
  })

  it("lists the native connectors with their declared permissions, and the registered MCP servers", async () => {
    const created = await app.request("/connectors/mcp", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(fake),
    })
    expect(created.status).toBe(201)
    const catalog = await readCatalog()
    const github = catalog.connectors.find((entry) => entry.id === "github")
    expect(github).toMatchObject({ kind: "native", status: "enabled", lastUsedAt: null })
    expect(github?.permissions.length).toBeGreaterThan(0)
    expect(catalog.connectors.find((entry) => entry.name === "Notion")?.kind).toBe("native")
    expect(catalog.connectors.find((entry) => entry.name === "fake")).toMatchObject({
      kind: "mcp",
      status: "enabled",
      bots: [],
    })
  })

  it("rejects an MCP server with a reserved name, or an env entry that is not a Vault key name", async () => {
    const reserved = await app.request("/connectors/mcp", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...fake, name: "reef" }),
    })
    expect(reserved.status).toBe(400)
    const inline = await app.request("/connectors/mcp", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ...fake, name: "inline", envKeys: ["sk-live-not-a-key"] }),
    })
    expect(inline.status).toBe(400)
  })

  it("grants an MCP server to a Bot by name, and takes the grant away with an empty list", async () => {
    const id = (await readCatalog()).connectors.find((entry) => entry.name === "fake")?.id ?? ""
    const granted = await app.request(`/connectors/${id}/bots`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ bots: ["dev"] }),
    })
    expect(granted.status).toBe(200)
    const afterGrant = Schema.decodeUnknownSync(OneConnector)(await granted.json())
    expect(afterGrant.connector.bots.map((bot) => bot.name)).toEqual(["dev"])
    expect(afterGrant.connector.bots[0]?.tools).toBe("*")

    const revoked = await app.request(`/connectors/${id}/bots`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ bots: [] }),
    })
    expect(revoked.status).toBe(200)
    expect(Schema.decodeUnknownSync(OneConnector)(await revoked.json()).connector.bots).toEqual([])
  })

  it("assigns a native connector to a Bot through the registry and its yaml file", async () => {
    const assigned = await app.request("/connectors/github/bots", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ bots: ["dev"] }),
    })
    expect(assigned.status).toBe(200)
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* BotRegistry).get(devId)
      }),
    )
    expect(stored.connectors).toContain("github")
    expect(readFileSync(join(botsDir, "dev.yaml"), "utf8")).toContain("github")
    const github = (await readCatalog()).connectors.find((entry) => entry.id === "github")
    expect(github?.bots.map((bot) => bot.name)).toEqual(["dev"])
  })

  it("answers 404 for an unknown connector or an unknown Bot", async () => {
    const connector = await app.request("/connectors/nope/bots", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ bots: [] }),
    })
    expect(connector.status).toBe(404)
    const botRef = await app.request("/connectors/github/bots", {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ bots: ["ghost"] }),
    })
    expect(botRef.status).toBe(404)
  })

  it("lists the recent calls of an MCP connector from the log, with the tool prefixed by its server", async () => {
    const id = (await readCatalog()).connectors.find((entry) => entry.name === "fake")?.id ?? ""
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Beacon).append({
          streamId: streamIds.bot(devId),
          type: "mcp.called",
          payload: { botId: devId, server: "fake", tool: "echo", decision: "allow", ok: true, durationMs: 5 },
          actor: "system:mcp",
          correlationId: "corr-usage",
        })
      }),
    )
    const usage = Schema.decodeUnknownSync(Usage)(
      await (await app.request(`/connectors/${id}/usage`, { headers: AUTH })).json(),
    )
    expect(usage.usage).toHaveLength(1)
    expect(usage.usage[0]).toMatchObject({ tool: "mcp__fake__echo", ok: true, decision: "allow" })
    const fakeEntry = (await readCatalog()).connectors.find((entry) => entry.id === id)
    expect(fakeEntry?.lastUsedAt).not.toBeNull()
  })

  it("reports no usage for a native connector that nothing has called", async () => {
    const usage = Schema.decodeUnknownSync(Usage)(
      await (await app.request("/connectors/notion/usage", { headers: AUTH })).json(),
    )
    expect(usage.usage).toEqual([])
  })
})
