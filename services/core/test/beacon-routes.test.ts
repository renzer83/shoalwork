import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, type NewEvent, streamIds, TaskId } from "@shoalwork/contracts"
import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import { parseBeaconCostsQuery, parseBeaconEventsQuery } from "../src/http/routes/beacon.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DAY_MS = 86_400_000

const TASK_A = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK_B = Schema.decodeUnknownSync(TaskId)("task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
const BOT_X = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")

// Events are stamped at append time, so the fixture falls in the default windows.
const runtime = ManagedRuntime.make(BeaconTest)
afterAll(() => runtime.dispose())
const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const usage = (tokensIn: number, usd: number) => ({
  tokensIn,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
  seconds: 1,
})

const onTask = (taskId: TaskId, type: NewEvent["type"], payload: object): NewEvent => ({
  streamId: streamIds.task(taskId),
  type,
  payload,
  actor: "system:test",
  correlationId: "corr_beacon_routes",
})

const FIXTURE: ReadonlyArray<NewEvent> = [
  onTask(TASK_A, "task.received", {
    task: {
      id: TASK_A,
      botId: BOT_X,
      title: "t",
      prompt: "p",
      kind: "code",
      acceptance: [],
      budget: { tokens: 1, seconds: 1, usd: 1 },
      tier: "light",
      origin: "cli",
    },
  }),
  onTask(TASK_A, "decision.made", {
    decisionId: "dec_a",
    questionId: "q_route",
    kind: "choice",
    value: "a",
    confidence: 0.9,
    source: "rule",
    facts: {},
  }),
  onTask(TASK_A, "decision.made", {
    decisionId: "dec_b",
    questionId: "q_route",
    kind: "choice",
    value: "b",
    confidence: 0.5,
    source: "model",
    facts: {},
  }),
  onTask(TASK_A, "context.assembled", {
    taskId: TASK_A,
    level: "full",
    used: 400,
    budget: 6000,
    dropped: [{ block: "memory", items: 2 }],
    compaction: [{ block: "code", level: 2, before: 1000, after: 400 }],
  }),
  onTask(TASK_A, "executor.started", {
    taskId: TASK_A,
    botId: BOT_X,
    executor: "codex",
    model: "m",
    cwd: "/w",
  }),
  onTask(TASK_A, "usage.recorded", {
    taskId: TASK_A,
    botId: BOT_X,
    executor: "codex",
    model: "claude-haiku-5-5",
    usage: usage(500, 0.05),
  }),
  onTask(TASK_A, "executor.finished", {
    taskId: TASK_A,
    botId: BOT_X,
    verdict: {
      kind: "ok",
      summary: "s",
      evidence: [],
      cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
    },
    durationMs: 1000,
  }),
  onTask(TASK_B, "usage.recorded", {
    taskId: TASK_B,
    botId: BOT_X,
    executor: "claude-code",
    model: "claude-sonnet-5",
    usage: usage(100, 0.01),
  }),
]

const seeded = runtime.runPromise(
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.appendMany(FIXTURE)
  }),
)

const get = async (path: string) => {
  await seeded
  return app.request(path, { headers: AUTH })
}

interface EventsBody {
  readonly events: ReadonlyArray<{
    readonly type: string
    readonly position: number
    readonly payload: unknown
  }>
  readonly nextBefore: number | null
}

describe("parsers", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")

  it("accepts tier as a Farol cost dimension and refuses an unknown one", () => {
    expect(parseBeaconCostsQuery({ by: "tier", since: undefined, until: undefined }, now).ok).toBe(true)
    const bad = parseBeaconCostsQuery({ by: "day", since: undefined, until: undefined }, now)
    expect(bad).toMatchObject({ ok: false, response: { status: 400, body: { param: "by" } } })
  })

  it("refuses a cost window longer than 31 days and an empty one", () => {
    const tooLong = parseBeaconCostsQuery({ by: undefined, since: "40d", until: undefined }, now)
    expect(tooLong).toMatchObject({ ok: false, response: { body: { param: "since" } } })
    const empty = parseBeaconCostsQuery(
      { by: undefined, since: "2026-10-21T12:00:00Z", until: "2026-10-21T12:00:00Z" },
      now,
    )
    expect(empty).toMatchObject({ ok: false, response: { body: { param: "until" } } })
  })

  it("bounds the event page, the free text and the event types", () => {
    const base = {
      types: undefined,
      stream: undefined,
      actor: undefined,
      q: undefined,
      before: undefined,
      limit: undefined,
      since: undefined,
      until: undefined,
    }
    const defaults = parseBeaconEventsQuery(base, now)
    expect(defaults).toMatchObject({ ok: true, value: { limit: 100 } })
    expect(parseBeaconEventsQuery({ ...base, limit: "501" }, now)).toMatchObject({
      response: { body: { param: "limit" } },
    })
    expect(parseBeaconEventsQuery({ ...base, limit: "0" }, now)).toMatchObject({
      response: { body: { param: "limit" } },
    })
    expect(parseBeaconEventsQuery({ ...base, q: "x".repeat(201) }, now)).toMatchObject({
      response: { body: { param: "q" } },
    })
    expect(parseBeaconEventsQuery({ ...base, types: "decision.made,nope" }, now)).toMatchObject({
      response: { body: { param: "types" } },
    })
    expect(parseBeaconEventsQuery({ ...base, since: "30d" }, now)).toMatchObject({
      response: { body: { param: "since" } },
    })
  })
})

describe("GET /beacon/savings", () => {
  it("rejects a request without the bearer token", async () => {
    const res = await app.request("/beacon/savings")
    expect(res.status).toBe(401)
  })

  it("values the local decisions and the compacted context from the log", async () => {
    const res = await get("/beacon/savings")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      decisions: { total: number; rule: number; localPct: number }
      decisionUsd: number
      avoidedUsd: number
      context: { tokensCut: number; cutPct: number; droppedItems: number }
    }
    expect(body.decisions).toMatchObject({ total: 2, rule: 1, model: 1, localPct: 50 })
    expect(body.decisionUsd).toBeCloseTo(0.05, 10)
    expect(body.avoidedUsd).toBeCloseTo(0.05, 10)
    expect(body.context).toMatchObject({ tokensCut: 600, cutPct: 60, droppedItems: 2 })
  })
})

describe("GET /beacon/costs", () => {
  it("groups by tier using the task.received of the window", async () => {
    const res = await get("/beacon/costs?by=tier")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: ReadonlyArray<{ key: string; usd: number }> }
    expect(body.rows.map((row) => [row.key, row.usd])).toEqual([
      ["light", 0.05],
      ["unknown", 0.01],
    ])
  })

  it("keeps refusing tier on the bare cost report", async () => {
    const res = await get("/costs?by=tier")
    expect(res.status).toBe(400)
  })

  it("returns one row per day of the window", async () => {
    const res = await get("/beacon/costs/daily?since=2d")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { days: ReadonlyArray<{ day: string; n: number; usd: number }> }
    expect(body.days.length).toBeGreaterThanOrEqual(2)
    expect(body.days.reduce((sum, day) => sum + day.usd, 0)).toBeCloseTo(0.06, 10)
  })
})

describe("GET /beacon/events", () => {
  it("filters by free text on the payload, case-insensitively", async () => {
    const res = await get("/beacon/events?q=HAIKU")
    const body = (await res.json()) as EventsBody
    expect(body.events.map((event) => event.type)).toEqual(["usage.recorded"])
  })

  it("pages newest first and reports the cursor of the next page", async () => {
    const first = (await (
      await get("/beacon/events?limit=3&types=usage.recorded,decision.made,executor.finished")
    ).json()) as EventsBody
    expect(first.events).toHaveLength(3)
    expect(first.events[0]?.position).toBeGreaterThan(first.events[1]?.position ?? 0)
    expect(first.nextBefore).toBe(first.events[2]?.position)

    const next = (await (
      await get(
        `/beacon/events?limit=3&types=usage.recorded,decision.made,executor.finished&before=${first.nextBefore}`,
      )
    ).json()) as EventsBody
    expect(next.events.every((event) => (event.position ?? 0) < (first.nextBefore ?? 0))).toBe(true)
  })

  it("keeps the window ceiling: a range over 7 days is refused", async () => {
    const res = await get(`/beacon/events?since=${new Date(Date.now() - 8 * DAY_MS).toISOString()}`)
    expect(res.status).toBe(400)
  })
})
