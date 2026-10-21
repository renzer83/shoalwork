import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { ExecutorId, type Usage } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { QuotaConfig, QuotaStore, QuotaStoreLive } from "@shoalwork/executors"
import { Effect, Layer, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { RegistryFromConfig } from "../src/executors-compose.js"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
const HOUR_MS = 60 * 60 * 1000
const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")

// Synthetic limits for this test (not the shipped config): claude-code has 100 tokens per 5h; the chat adapter has
// no window at all.
const quotaConfig = Schema.decodeUnknownSync(QuotaConfig)({
  executors: { "claude-code": { windows: [{ kind: "5h", soft_tokens: 100 }] } },
})

// The real registry, store and Beacon, composed as the core composes them, over a temporary database.
const TestLayer = RegistryFromConfig(
  { permissionBridge: false, codexModel: undefined },
  DEFAULT_TIERS,
  quotaConfig,
).pipe(
  Layer.provideMerge(QuotaStoreLive(quotaConfig)),
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)
const runtime = ManagedRuntime.make(TestLayer)

const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const usage: Usage = { tokensIn: 30, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0, seconds: 0 }

const claudeQuota = (body: unknown): unknown => {
  const quotas = (body as { readonly quotas: ReadonlyArray<{ readonly executor: string }> }).quotas
  return quotas.find((quota) => quota.executor === "claude-code")
}

const post = (id: string, body: unknown, headers: Record<string, string> = AUTH) =>
  app.request(`/executors/${id}/quota`, { method: "POST", headers, body: JSON.stringify(body) })

// The quota events of one executor's stream, read back from the Beacon.
const eventsOf = (streamId: string) =>
  runEffect(
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const events = yield* Stream.runCollect(beacon.readStream(streamId))
      return Array.from(events).map((event) => ({
        type: event.type,
        payload: event.payload,
        actor: event.actor,
      }))
    }),
  )

describe("GET /executors/quota", () => {
  it("refuses a request without the API token", async () => {
    const response = await app.request("/executors/quota")
    expect(response.status).toBe(401)
  })

  it("refuses an execution token: it opens no quota route", async () => {
    const response = await app.request("/executors/quota", {
      headers: { authorization: "Bearer exec-token-that-is-not-the-api-token" },
    })
    expect(response.status).toBe(401)
  })

  it("lists the quota of every registered executor, with the store's figures", async () => {
    await runEffect(
      Effect.gen(function* () {
        const store = yield* QuotaStore
        yield* store.record(CLAUDE, usage)
      }),
    )
    const response = await app.request("/executors/quota", { headers: AUTH })
    expect(response.status).toBe(200)
    expect(claudeQuota(await response.json())).toMatchObject({
      executor: "claude-code",
      usedRatio: 0.3,
      available: true,
    })
  })
})

describe("POST /executors/:id/quota", () => {
  // The window is shared with the GET test's usage, so its end is the later of the open window's end and `until`:
  // the assertions check that rule, not a fixed end.
  it("marks the executor exhausted until the given instant, and clears it with null", async () => {
    const until = new Date(Date.now() + 2 * HOUR_MS).toISOString()
    const marked = await post("claude-code", { exhaustedUntil: until })
    expect(marked.status).toBe(200)
    const body = (await marked.json()) as { available: boolean; windowEndsAt: string }
    expect(body.available).toBe(false)
    expect(Date.parse(body.windowEndsAt)).toBeGreaterThanOrEqual(Date.parse(until))

    const cleared = await post("claude-code", { exhaustedUntil: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ executor: "claude-code", available: true, usedRatio: 0.3 })
  })

  it("extends the window but never shortens it", async () => {
    const later = new Date(Date.now() + 4 * HOUR_MS).toISOString()
    const earlier = new Date(Date.now() + 1 * HOUR_MS).toISOString()
    const extended = (await (await post("claude-code", { exhaustedUntil: later })).json()) as {
      windowEndsAt: string
    }
    const response = await post("claude-code", { exhaustedUntil: earlier })
    expect(await response.json()).toMatchObject({ available: false, windowEndsAt: extended.windowEndsAt })
    expect(Date.parse(extended.windowEndsAt)).toBeGreaterThanOrEqual(Date.parse(later))
    await post("claude-code", { exhaustedUntil: null })
  })

  it("writes an executor.quota_adjusted event to the executor's stream for each change", async () => {
    const until = new Date(Date.now() + 3 * HOUR_MS).toISOString()
    await post("claude-code", { exhaustedUntil: until })
    await post("claude-code", { exhaustedUntil: null })
    const events = (await eventsOf("executor:claude-code")).filter(
      (event) => event.type === "executor.quota_adjusted",
    )
    expect(events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        { executor: "claude-code", exhaustedUntil: until, by: "api" },
        { executor: "claude-code", exhaustedUntil: null, by: "api" },
      ]),
    )
    expect(events.every((event) => event.actor === "api")).toBe(true)
  })

  it("answers 409 for an executor with no window in quotas.yaml, and writes no event", async () => {
    const response = await post("claude-code@chat", { exhaustedUntil: null })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "conflict", reason: "executor has no quota window" })
    expect(await eventsOf("executor:claude-code@chat")).toEqual([])
  })

  it("answers 404 for an executor that is not registered", async () => {
    const response = await post("no-such-executor", { exhaustedUntil: null })
    expect(response.status).toBe(404)
  })

  it("answers 400 for a time that is not an ISO instant", async () => {
    const response = await post("claude-code", { exhaustedUntil: "tomorrow" })
    expect(response.status).toBe(400)
  })

  it("answers 400 when the body has no exhaustedUntil key", async () => {
    const response = await post("claude-code", {})
    expect(response.status).toBe(400)
  })

  it("answers 400 for a body that is not JSON", async () => {
    const response = await app.request("/executors/claude-code/quota", {
      method: "POST",
      headers: AUTH,
      body: "exhaustedUntil=tomorrow",
    })
    expect(response.status).toBe(400)
  })

  it("refuses a request without the API token", async () => {
    const response = await post(
      "claude-code",
      { exhaustedUntil: null },
      { "content-type": "application/json" },
    )
    expect(response.status).toBe(401)
  })

  it("refuses an execution token", async () => {
    const response = await post(
      "claude-code",
      { exhaustedUntil: null },
      { authorization: "Bearer exec-token-that-is-not-the-api-token", "content-type": "application/json" },
    )
    expect(response.status).toBe(401)
  })
})
