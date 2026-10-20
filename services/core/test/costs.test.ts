import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, type NewEvent, streamIds, TaskId } from "@shoalwork/contracts"
import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import { parseBound, parseCostsQuery } from "../src/http/routes/costs.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DAY_MS = 86_400_000

const TASK_A = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK_B = Schema.decodeUnknownSync(TaskId)("task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
const BOT_X = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")

// The Beacon stamps occurredAt at append time, so every fixture event falls in the current window.
const runtime = ManagedRuntime.make(BeaconTest)
afterAll(() => runtime.dispose())
const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const usage = (tokensIn: number, tokensOut: number, usd: number) => ({
  tokensIn,
  tokensOut,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
  seconds: 1,
})

const verdict = (kind: string) => ({
  kind,
  summary: "s",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
})

const onTask = (taskId: TaskId, type: NewEvent["type"], payload: object): NewEvent => ({
  streamId: streamIds.task(taskId),
  type,
  payload,
  actor: "system:test",
  correlationId: "corr_costs_route",
})

// Task A: codex, one ok run with 400 context tokens. Task B: no executor.started, verdict failed.
const FIXTURE: ReadonlyArray<NewEvent> = [
  onTask(TASK_A, "executor.started", {
    taskId: TASK_A,
    botId: BOT_X,
    executor: "codex",
    model: "m",
    cwd: "/w",
  }),
  onTask(TASK_A, "context.assembled", {
    taskId: TASK_A,
    level: "full",
    used: 400,
    budget: 6000,
    dropped: [],
  }),
  onTask(TASK_A, "usage.recorded", {
    taskId: TASK_A,
    botId: BOT_X,
    executor: "codex",
    model: "m",
    usage: usage(500, 50, 0.05),
  }),
  onTask(TASK_A, "executor.finished", {
    taskId: TASK_A,
    botId: BOT_X,
    verdict: verdict("ok"),
    durationMs: 1000,
  }),
  onTask(TASK_B, "usage.recorded", {
    taskId: TASK_B,
    botId: BOT_X,
    executor: "claude-code",
    model: "m",
    usage: usage(100, 10, 0.01),
  }),
  onTask(TASK_B, "executor.finished", {
    taskId: TASK_B,
    botId: BOT_X,
    verdict: verdict("failed"),
    durationMs: 1000,
  }),
]

const seeded = runtime.runPromise(
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.appendMany(FIXTURE)
  }),
)

interface CostRowBody {
  readonly key: string
  readonly n: number
  readonly tokensIn: number
  readonly contextTokensAvg: number | null
  readonly okRate: number | null
}
interface CostsBodyShape {
  readonly rows: ReadonlyArray<CostRowBody>
  readonly delta: { readonly tokensInPct: number | null; readonly okRatePct: number | null }
}
interface ErrorBody {
  readonly error: string
  readonly param?: string
}

const getCosts = async (query: string) => {
  await seeded
  return app.request(`/costs${query}`, { headers: AUTH })
}

describe("GET /costs", () => {
  it("rejects a request without the bearer token", async () => {
    const res = await app.request("/costs")
    expect(res.status).toBe(401)
  })

  it("groups by task by default, with n, tokens, context mean and okRate", async () => {
    const res = await getCosts("")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CostsBodyShape
    expect(body.rows.map((row) => row.key)).toEqual([TASK_A, TASK_B])
    expect(body.rows[0]).toMatchObject({ n: 1, tokensIn: 500, contextTokensAvg: 400, okRate: 1 })
    expect(body.rows[1]).toMatchObject({ n: 1, tokensIn: 100, contextTokensAvg: null, okRate: 0 })
    expect(body.delta).toEqual({ tokensInPct: null, okRatePct: null })
  })

  it("groups by bot and by executor", async () => {
    const byBot = (await (await getCosts("?by=bot")).json()) as CostsBodyShape
    expect(byBot.rows).toHaveLength(1)
    expect(byBot.rows[0]).toMatchObject({ key: BOT_X, n: 2, tokensIn: 600, okRate: 0.5 })

    const byExecutor = (await (await getCosts("?by=executor")).json()) as CostsBodyShape
    expect(byExecutor.rows.map((row) => row.key)).toEqual(["codex", "claude-code"])
    expect(byExecutor.rows[0]).toMatchObject({ n: 1, tokensIn: 500, contextTokensAvg: 400 })
  })

  it("answers a compareWith baseline that holds no events with null deltas", async () => {
    const res = await getCosts("?since=7d&compareWith=14d")
    expect(res.status).toBe(200)
    const body = (await res.json()) as CostsBodyShape
    expect(body.rows).toHaveLength(2)
    expect(body.delta).toEqual({ tokensInPct: null, okRatePct: null })
  })

  it("accepts an ISO since in the past", async () => {
    const res = await getCosts("?since=2020-01-01T00:00:00Z")
    expect(res.status).toBe(200)
    expect(((await res.json()) as CostsBodyShape).rows).toHaveLength(2)
  })

  it("names the invalid parameter with a 400", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["?by=weekly", "by"],
      ["?since=yesterday", "since"],
      ["?since=1h&until=2h", "until"],
      ["?compareWith=1d", "compareWith"],
      ["?compareWith=nope", "compareWith"],
    ]
    for (const [query, param] of cases) {
      const res = await getCosts(query)
      expect(res.status, query).toBe(400)
      expect(((await res.json()) as ErrorBody).param, query).toBe(param)
    }
  })
})

describe("parseBound", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")

  it("reads relative bounds in days and hours against now", () => {
    expect(parseBound("7d", now)).toBe(now - 7 * DAY_MS)
    expect(parseBound("24h", now)).toBe(now - 24 * 3_600_000)
  })

  it("reads ISO-8601 UTC bounds and rejects everything else", () => {
    expect(parseBound("2026-10-01T00:00:00Z", now)).toBe(Date.parse("2026-10-01T00:00:00Z"))
    expect(parseBound("0d", now)).toBeUndefined()
    expect(parseBound("7", now)).toBeUndefined()
    expect(parseBound("2026-13-40T00:00:00Z", now)).toBeUndefined()
  })
})

describe("parseCostsQuery", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")
  const none = { by: undefined, since: undefined, until: undefined, compareWith: undefined }

  it("defaults to the last 7 days grouped by task, with no baseline", () => {
    const parsed = parseCostsQuery(none, now)
    expect(parsed).toEqual({
      ok: true,
      query: { by: "task", current: { since: now - 7 * DAY_MS, until: now }, baseline: undefined },
    })
  })

  it("makes the baseline end where the current window starts", () => {
    const parsed = parseCostsQuery({ ...none, since: "7d", compareWith: "14d" }, now)
    expect(parsed).toEqual({
      ok: true,
      query: {
        by: "task",
        current: { since: now - 7 * DAY_MS, until: now },
        baseline: { since: now - 14 * DAY_MS, until: now - 7 * DAY_MS },
      },
    })
  })
})
