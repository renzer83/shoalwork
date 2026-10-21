import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { type NewEvent, streamIds } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const CORRELATION = "corr_reflex_export"

// Real SQLite file for the suite; the export reads the Beacon only.
const runtime = ManagedRuntime.make(Layer.provideMerge(BeaconLive, withTempDb()))
afterAll(() => runtime.dispose())

const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const decisionMade: NewEvent = {
  streamId: streamIds.system,
  type: "decision.made",
  payload: {
    decisionId: "evt_export_decision_1",
    questionId: "intent",
    kind: "choice",
    value: "code",
    confidence: 0.9,
    source: "rule",
    facts: {
      text: "implementa o login",
      channel: "api",
      userId: "424242",
      bots: [],
      executors: [],
      hasRepo: false,
    },
  },
  actor: "system:reflex",
  correlationId: CORRELATION,
}

const decisionOutcome: NewEvent = {
  streamId: streamIds.system,
  type: "decision.outcome",
  payload: { decisionId: "evt_export_decision_1", outcome: "correct" },
  actor: "system:lead",
  correlationId: CORRELATION,
}

describe("GET /reflex/export", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await app.request("/reflex/export")
    expect(res.status).toBe(401)
  })

  it("answers an empty NDJSON body while no decision has an outcome", async () => {
    const res = await app.request("/reflex/export", { headers: AUTH })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/x-ndjson")
    expect(await res.text()).toBe("")
  })

  it("streams one line per decision that has an outcome, without user identifiers", async () => {
    await runEffect(
      Effect.gen(function* () {
        const beacon = yield* Beacon
        yield* beacon.appendMany([decisionMade, decisionOutcome])
      }),
    )
    const res = await app.request("/reflex/export", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await res.text()
    const lines = body.split("\n").filter((line) => line !== "")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      decisionId: "evt_export_decision_1",
      ts: expect.any(String),
      correlationId: CORRELATION,
      question: { id: "intent", kind: "choice" },
      outcome: "correct",
    })
    expect(body).not.toContain("424242")
    expect(body).not.toContain("userId")
  })
})
