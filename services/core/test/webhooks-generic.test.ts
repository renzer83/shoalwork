import { createHash } from "node:crypto"
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
import { WEBHOOK_BODY_LIMIT_BYTES } from "../src/http/routes/webhooks-generic.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

type LeadInput = Parameters<LeadShape["intake"]>[0]

// Records every task the Tides intake, so a test can see what a firing created (or that it created nothing).
const intakes: Array<LeadInput> = []
const leadStub: LeadShape = {
  intake: (input) =>
    Effect.sync(() => {
      intakes.push(input)
      return { ...input, id: newTaskId(), tier: input.tier ?? "light" }
    }),
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
  title: "Deploy",
  prompt: "Deploy {{payload.service}} to {{payload.env}}",
  kind: "research",
  tier: "light",
  budget: { tokens: 500, seconds: 300, usd: 0.5 },
}

const createBot = runEffect(
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    return yield* registry.upsert(SCOUT, "test")
  }),
)

// A cron tide: the webhook fires any Tide, whatever its trigger, and a cron needs no event type.
const tideBody = (name: string, overrides: Record<string, unknown> = {}) => ({
  bot: "scout",
  name,
  kind: "cron",
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  taskTemplate: TEMPLATE,
  ...overrides,
})

const createTide = async (name: string, overrides: Record<string, unknown> = {}): Promise<string> => {
  await createBot
  const response = await app.request("/tides", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(tideBody(name, overrides)),
  })
  const { tide } = (await response.json()) as { readonly tide: { readonly id: string } }
  return tide.id
}

const rotate = async (id: string): Promise<{ readonly status: number; readonly secret: string }> => {
  const response = await app.request(`/tides/${id}/webhook-secret`, { method: "POST", headers: AUTH })
  const body = (await response.json()) as { readonly secret?: string }
  return { status: response.status, secret: body.secret ?? "" }
}

const hook = (id: string, body: string, headers: Record<string, string> = {}) =>
  app.request(`/webhooks/generic/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })

const deployBody = JSON.stringify({ service: "api", env: "prod", kind: "deploy" })

const storedSecret = (id: string) =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const rows = yield* sql<{ readonly secret: string | null }>`SELECT secret FROM tides WHERE id = ${id}`
      return rows[0]?.secret ?? null
    }),
  )

describe("POST /webhooks/generic/:tideId", () => {
  it("fires the tide with the right secret and answers 201 with the task", async () => {
    const id = await createTide("gen-ok")
    const { secret } = await rotate(id)
    const before = intakes.length
    const response = await hook(id, deployBody, { "x-webhook-secret": secret })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ task: { origin: "tide" } })
    expect(intakes.length).toBe(before + 1)
  })

  it("answers 401 to a wrong secret and creates no task", async () => {
    const id = await createTide("gen-wrong")
    await rotate(id)
    const before = intakes.length
    const response = await hook(id, deployBody, { "x-webhook-secret": "not-the-secret" })
    expect(response.status).toBe(401)
    expect(intakes.length).toBe(before)
  })

  it("answers the same 401 for a wrong secret, an unknown tide, a malformed id and a tide with no secret", async () => {
    const withSecret = await createTide("gen-uniform-a")
    await rotate(withSecret)
    const noSecret = await createTide("gen-uniform-b")
    const wrong = await hook(withSecret, deployBody, { "x-webhook-secret": "nope" })
    const unknown = await hook(newTideId(), deployBody, { "x-webhook-secret": "nope" })
    const malformed = await hook("not-a-tide", deployBody, { "x-webhook-secret": "nope" })
    const unsecured = await hook(noSecret, deployBody, { "x-webhook-secret": "nope" })
    for (const response of [wrong, unknown, malformed, unsecured]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "unauthorized" })
    }
  })

  it("rotation replaces the secret: the previous one answers 401", async () => {
    const id = await createTide("gen-rotate")
    const first = await rotate(id)
    const second = await rotate(id)
    expect(second.secret).not.toBe(first.secret)
    const old = await hook(id, deployBody, { "x-webhook-secret": first.secret })
    expect(old.status).toBe(401)
    const current = await hook(id, deployBody, { "x-webhook-secret": second.secret })
    expect(current.status).toBe(201)
  })

  it("a generated secret is at least 32 random bytes and stored only as its SHA-256", async () => {
    const id = await createTide("gen-hash")
    const { secret } = await rotate(id)
    expect(Buffer.from(secret, "base64url").length).toBeGreaterThanOrEqual(32)
    const stored = await storedSecret(id)
    expect(stored).not.toBe(secret)
    expect(stored).toBe(createHash("sha256").update(secret).digest("hex"))
  })

  it("never returns the secret or its hash on the tide list", async () => {
    const id = await createTide("gen-list")
    const { secret } = await rotate(id)
    const listed = await app.request("/tides", { headers: AUTH })
    const text = await listed.text()
    expect(text).toContain("gen-list")
    expect(text).not.toContain(secret)
    expect(text).not.toContain(createHash("sha256").update(secret).digest("hex"))
  })

  it("answers 413 to a body over 256 KB and reads nothing into a firing", async () => {
    const id = await createTide("gen-big")
    const { secret } = await rotate(id)
    const before = intakes.length
    const oversized = JSON.stringify({ service: "a".repeat(WEBHOOK_BODY_LIMIT_BYTES) })
    const response = await hook(id, oversized, { "x-webhook-secret": secret })
    expect(response.status).toBe(413)
    expect(intakes.length).toBe(before)
  })

  it("accepts a body of exactly 256 KB", async () => {
    const id = await createTide("gen-edge")
    const { secret } = await rotate(id)
    const frame = JSON.stringify({ service: "api", env: "prod", kind: "deploy", pad: "" })
    const exact = JSON.stringify({
      service: "api",
      env: "prod",
      kind: "deploy",
      pad: "p".repeat(WEBHOOK_BODY_LIMIT_BYTES - frame.length),
    })
    expect(Buffer.byteLength(exact)).toBe(WEBHOOK_BODY_LIMIT_BYTES)
    const response = await hook(id, exact, { "x-webhook-secret": secret })
    expect(response.status).toBe(201)
  })

  it("answers 415 when the body is not declared as JSON", async () => {
    const id = await createTide("gen-type")
    const { secret } = await rotate(id)
    const response = await app.request(`/webhooks/generic/${id}`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-webhook-secret": secret },
      body: deployBody,
    })
    expect(response.status).toBe(415)
  })

  it("answers 404 for a disabled tide, even with the right secret", async () => {
    const id = await createTide("gen-disabled", { enabled: false })
    const { secret } = await rotate(id)
    const before = intakes.length
    const response = await hook(id, deployBody, { "x-webhook-secret": secret })
    expect(response.status).toBe(404)
    expect(intakes.length).toBe(before)
  })

  it("interpolates the body into the template as JSON literals", async () => {
    const id = await createTide("gen-interp")
    const { secret } = await rotate(id)
    const before = intakes.length
    const hostile = JSON.stringify({ service: 'api" and "x', env: "prod", kind: "deploy" })
    await hook(id, hostile, { "x-webhook-secret": secret })
    expect(intakes.length).toBe(before + 1)
    expect(intakes[before]?.prompt).toBe('Deploy "api\\" and \\"x" to "prod"')
  })

  it("records tide.fired with trigger event", async () => {
    const id = await createTide("gen-trigger")
    const { secret } = await rotate(id)
    await hook(id, deployBody, { "x-webhook-secret": secret })
    const fired = await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        return yield* sql<{ readonly payload: string }>`SELECT payload FROM events
          WHERE type = 'tide.fired' AND json_extract(payload, '$.tideId') = ${id}`
      }),
    )
    expect(
      fired.map((row) => JSON.parse(row.payload) as { readonly trigger: string }).map((p) => p.trigger),
    ).toEqual(["event"])
  })

  it("keeps the tide's cooldown: a second webhook inside it answers 409", async () => {
    const id = await createTide("gen-cooldown")
    const { secret } = await rotate(id)
    const first = await hook(id, deployBody, { "x-webhook-secret": secret })
    expect(first.status).toBe(201)
    const second = await hook(id, deployBody, { "x-webhook-secret": secret })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: "tide skipped", reason: "cooldown" })
  })

  it("answers 400 to a body that is not JSON once the secret is right", async () => {
    const id = await createTide("gen-badjson")
    const { secret } = await rotate(id)
    const response = await hook(id, "{not json", { "x-webhook-secret": secret })
    expect(response.status).toBe(400)
  })

  it("rotating the secret needs the API token", async () => {
    const id = await createTide("gen-noauth")
    const response = await app.request(`/tides/${id}/webhook-secret`, { method: "POST" })
    expect(response.status).toBe(401)
  })
})
