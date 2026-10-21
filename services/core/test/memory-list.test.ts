import { type Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type BotId, NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type Reef, ReefTest } from "@shoalwork/reef"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const coreRuntime = ManagedRuntime.make(Layer.provideMerge(BeaconLive, withTempDb()))
const memoryRuntime = ManagedRuntime.make(
  Layer.provideMerge(
    BotRegistryLive,
    Layer.provideMerge(ReefTest, Layer.provideMerge(BeaconLive, withTempDb())),
  ),
)
const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => coreRuntime.runPromise(eff)
const runMemory = <A, E>(eff: Effect.Effect<A, E, Reef | SqlClient | BotRegistry>): Promise<A> =>
  memoryRuntime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect, runMemory })

const BOT = Schema.decodeUnknownSync(NewBot)({
  name: "memo",
  role: "keeper",
  kind: "auxiliary",
  instructions: "Keep the notes.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 60, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

let botId = ""
beforeAll(async () => {
  botId = await runMemory(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return (yield* registry.upsert(BOT, "test")).id
    }),
  )
})

afterAll(async () => {
  await coreRuntime.dispose()
  await memoryRuntime.dispose()
})

const remember = async (content: string): Promise<string> => {
  const res = await app.request("/memory", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ scope: "bot", ownerId: botId as BotId, kind: "semantic", content, userId: "app" }),
  })
  return ((await res.json()) as { item: { id: string } }).item.id
}

const list = async (query = ""): Promise<Response> =>
  app.request(`/memory?bot=${botId}${query}`, { headers: AUTH })

describe("GET /memory without q", () => {
  it("lists the Bot's items newest first", async () => {
    await remember("first fact")
    await new Promise((resolve) => setTimeout(resolve, 5))
    await remember("second fact")
    const res = await list()
    expect(res.status).toBe(200)
    const items = (await res.json()) as Array<{ content: string }>
    expect(items.map((item) => item.content).slice(0, 2)).toEqual(["second fact", "first fact"])
  })

  it("leaves forgotten items out of the list", async () => {
    const id = await remember("gone fact")
    await app.request(`/memory/${id}`, { method: "DELETE", headers: AUTH })
    const items = (await (await list()).json()) as Array<{ content: string }>
    expect(items.map((item) => item.content)).not.toContain("gone fact")
  })

  it("filters by kind in list mode", async () => {
    const items = (await (await list("&kinds=procedural")).json()) as Array<unknown>
    expect(items).toEqual([])
  })

  it("keeps the search: q with text still answers hits", async () => {
    const res = await list("&q=second")
    expect(res.status).toBe(200)
    const hits = (await res.json()) as Array<{ content: string }>
    expect(hits.map((hit) => hit.content)).toContain("second fact")
  })

  it("answers 400 for an empty q, which is a search with no text", async () => {
    expect((await list("&q=")).status).toBe(400)
  })
})
