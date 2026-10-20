import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { NewBot, newTaskId, newTideId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Lead, type LeadShape } from "@shoalwork/lead"
import { TidesLive } from "@shoalwork/tides"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

// The Lead is not under test here: intake answers with a task spec and nothing runs.
const leadStub: LeadShape = {
  intake: (input) => Effect.sync(() => ({ ...input, id: newTaskId(), tier: input.tier ?? "light" })),
  get: () => Effect.die("not used by the tide routes"),
  runOnce: () => Effect.die("not used by the tide routes"),
  handoff: () => Effect.die("not used by the tide routes"),
  abandon: () => Effect.void,
  startWorker: () => Effect.void,
}

const TestLayer = TidesLive({ botBudgetWindowMs: 24 * 60 * 60 * 1000 }).pipe(
  Layer.provideMerge(Layer.mergeAll(BotRegistryLive, Layer.succeed(Lead, leadStub))),
  Layer.provideMerge(BeaconLive.pipe(Layer.provideMerge(withTempDb()))),
)

const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

afterAll(async () => {
  await runtime.dispose()
})

const SCOUT = Schema.decodeUnknownSync(NewBot)({
  name: "scout",
  role: "scout",
  instructions: "look around",
  kind: "auxiliary",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 600, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const TEMPLATE = {
  title: "Check the queue",
  prompt: "Look at the queue",
  kind: "research",
  tier: "light",
  budget: { tokens: 500, seconds: 300, usd: 0.5 },
}

const tideBody = (overrides: Record<string, unknown>) => ({
  bot: "scout",
  name: "morning",
  kind: "cron",
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  taskTemplate: TEMPLATE,
  ...overrides,
})

const createBot = runEffect(
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    return yield* registry.upsert(SCOUT, "test")
  }),
)

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: AUTH, body: JSON.stringify(body) })

describe("tide routes", () => {
  it("POST /tides stores a valid cron tide and answers 201", async () => {
    await createBot
    const response = await post("/tides", tideBody({}))
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      readonly tide: { readonly name: string; readonly enabled: boolean }
    }
    expect(body.tide.name).toBe("morning")
    expect(body.tide.enabled).toBe(true)
  })

  it("POST /tides answers 400 for a cron expression that cannot run", async () => {
    await createBot
    const response = await post("/tides", tideBody({ name: "bad-cron", cronExpr: "nope" }))
    expect(response.status).toBe(400)
  })

  it("POST /tides answers 400 for an unknown timezone", async () => {
    await createBot
    const response = await post("/tides", tideBody({ name: "bad-zone", timezone: "Mars/Olympus" }))
    expect(response.status).toBe(400)
  })

  it("POST /tides/:id/run answers 404 for a malformed id and for an unknown one", async () => {
    const malformed = await post("/tides/not-an-id/run", {})
    expect(malformed.status).toBe(404)
    const unknown = await post(`/tides/${newTideId()}/run`, {})
    expect(unknown.status).toBe(404)
  })

  it("POST /tides/:id/run answers 409 while the Bot is paused", async () => {
    await createBot
    const created = await post("/tides", tideBody({ name: "paused-one" }))
    const { tide } = (await created.json()) as {
      readonly tide: { readonly id: string; readonly botId: string }
    }
    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`INSERT INTO control_flags (scope, paused, updated_at)
          VALUES (${`bot:${tide.botId}`}, 1, ${new Date().toISOString()})`
      }),
    )
    const response = await post(`/tides/${tide.id}/run`, {})
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "tide skipped", reason: "paused" })
  })

  it("GET /tides without a bearer token answers 401", async () => {
    const response = await app.request("/tides")
    expect(response.status).toBe(401)
  })
})
