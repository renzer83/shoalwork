import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, type NewEvent, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import {
  type ContextCostsBody,
  contextCostsBody,
  parseContextQuery,
} from "../src/http/routes/costs-context.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const TASK = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const NOW = Date.parse("2026-10-21T12:00:00Z")

// Beacon for events, a temp SQLite for the baselines table.
const runtime = ManagedRuntime.make(Layer.merge(BeaconTest, withTempDb()))
afterAll(() => runtime.dispose())
const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon | SqlClient>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const verdict = {
  kind: "ok",
  summary: "s",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
}
const oneRun = (tokensIn: number): ReadonlyArray<NewEvent> => [
  {
    streamId: streamIds.task(TASK),
    type: "executor.started",
    payload: { taskId: TASK, botId: BOT, executor: "claude-code", model: "haiku", cwd: "/w" },
    actor: "system:test",
    correlationId: "corr_costs_context",
  },
  {
    streamId: streamIds.task(TASK),
    type: "usage.recorded",
    payload: {
      taskId: TASK,
      botId: BOT,
      executor: "claude-code",
      model: "haiku",
      usage: { tokensIn, tokensOut: 10, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 1 },
    },
    actor: "system:test",
    correlationId: "corr_costs_context",
  },
  {
    streamId: streamIds.task(TASK),
    type: "executor.finished",
    payload: { taskId: TASK, botId: BOT, verdict, durationMs: 1000 },
    actor: "system:test",
    correlationId: "corr_costs_context",
  },
]

const seedBaseline = (project: string, metric: string, value: number): Promise<void> =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO baselines (project, metric, value, window_from, window_to, computed_at)
        VALUES (${project}, ${metric}, ${value}, ${"2026-07-01T00:00:00.000Z"}, ${"2026-10-01T00:00:00.000Z"}, ${"2026-10-01T00:00:00.000Z"})`
    }),
  )

describe("parseContextQuery", () => {
  it("rejects an unknown by and a baseline project that is not a slug", () => {
    expect(
      parseContextQuery({ by: "tier", since: undefined, until: undefined, compareWith: undefined }, NOW),
    ).toMatchObject({
      ok: false,
      response: { status: 400, body: { param: "by" } },
    })
    expect(
      parseContextQuery(
        { by: "level", since: undefined, until: undefined, compareWith: "baseline:Bad Name" },
        NOW,
      ),
    ).toMatchObject({ ok: false, response: { status: 400, body: { param: "compareWith" } } })
  })

  it("accepts baseline:<project> and a window that ends where since starts", () => {
    const baseline = parseContextQuery(
      { by: "level", since: "7d", until: undefined, compareWith: "baseline:faturium" },
      NOW,
    )
    expect(baseline).toMatchObject({
      ok: true,
      query: { by: "level", compare: { kind: "baseline", project: "faturium" } },
    })
    const window = parseContextQuery(
      { by: undefined, since: "7d", until: undefined, compareWith: "14d" },
      NOW,
    )
    expect(window).toMatchObject({ ok: true, query: { by: "task", compare: { kind: "window" } } })
    expect(
      parseContextQuery({ by: undefined, since: "7d", until: undefined, compareWith: "2d" }, NOW),
    ).toMatchObject({
      ok: false,
      response: { status: 400, body: { param: "compareWith" } },
    })
  })
})

describe("contextCostsBody", () => {
  it("returns compare null and a note when there is no baseline row", () => {
    const body = contextCostsBody(
      [],
      {
        by: "task",
        current: { since: NOW - 86_400_000, until: NOW },
        compare: { kind: "baseline", project: "x" },
      },
      undefined,
    )
    expect(body.compare).toBeNull()
    expect(body.delta).toEqual({ tokensInAvgPct: null, okRatePct: null })
    expect(body.note).toContain('no baselines row for project "x"')
  })
})

describe("GET /costs/context", () => {
  it("answers 200 with the rows of the current window and no comparison", async () => {
    await runEffect(
      Effect.gen(function* () {
        const beacon = yield* Beacon
        yield* beacon.appendMany(oneRun(1200))
      }),
    )
    const res = await app.request("/costs/context?by=task", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextCostsBody
    expect(body.by).toBe("task")
    expect(body.totals.n).toBe(1)
    expect(body.totals.tokensInAvg).toBe(1200)
    expect(body.compare).toBeNull()
  })

  it("compares with the latest tokens_per_task baseline of the project", async () => {
    await seedBaseline("faturium", "tokens_per_task", 2000)
    const res = await app.request("/costs/context?by=task&compareWith=baseline:faturium", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextCostsBody
    expect(body.compare).toMatchObject({
      kind: "baseline",
      project: "faturium",
      value: 2000,
      metric: "tokens_per_task",
    })
    expect(body.delta.tokensInAvgPct).toBeCloseTo(((1200 - 2000) / 2000) * 100, 9)
    expect(body.delta.okRatePct).toBeNull()
    expect(body.note).toContain("okRate")
  })

  it("answers 200 with a null comparison for a project without a baseline row", async () => {
    const res = await app.request("/costs/context?by=task&compareWith=baseline:nothing", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextCostsBody
    expect(body.compare).toBeNull()
    expect(body.note).toContain('no baselines row for project "nothing"')
  })
})
