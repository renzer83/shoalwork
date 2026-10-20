import { it } from "@effect/vitest"
import { BotId, type Event, type NewEvent, streamIds, TaskId, type Usage } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import {
  Beacon,
  BeaconTest,
  botState,
  costByBot,
  costByTask,
  latestPerStream,
  readCostByTask,
  readTaskState,
  readUsageForBotSince,
  taskState,
  usageForBotSince,
} from "../src/index.js"

const TASK_A = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK_C = Schema.decodeUnknownSync(TaskId)("task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
const BOT_B = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const BOT_D = Schema.decodeUnknownSync(BotId)("bot_4a3b2c1d-9e8f-4a7b-8c6d-5e4f3a2b1c0d")

const usage = (tokensIn: number, tokensOut: number, usd: number): Usage => ({
  tokensIn,
  tokensOut,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
  seconds: 5,
})

const taskChanged = (taskId: TaskId, from: string, to: string): NewEvent => ({
  streamId: streamIds.task(taskId),
  type: "task.state_changed",
  payload: { taskId, from, to },
  actor: "system:watchdog",
  correlationId: "corr_projections",
})

const botChanged = (botId: BotId, from: string, to: string): NewEvent => ({
  streamId: streamIds.bot(botId),
  type: "bot.state_changed",
  payload: { botId, from, to },
  actor: `bot:${botId}`,
  correlationId: "corr_projections",
})

const usageEvent = (taskId: TaskId, botId: BotId, u: Usage): NewEvent => ({
  streamId: streamIds.task(taskId),
  type: "usage.recorded",
  payload: { taskId, botId, executor: "claude-code", model: "haiku", usage: u },
  actor: `bot:${botId}`,
  correlationId: "corr_projections",
})

// Ten events over three streams (task A, task C, bot B). Bot D only appears inside usage payloads.
const FIXTURE: ReadonlyArray<NewEvent> = [
  taskChanged(TASK_A, "received", "planning"), // position 1
  usageEvent(TASK_A, BOT_B, usage(100, 10, 0.01)), // 2
  usageEvent(TASK_A, BOT_B, usage(200, 20, 0.02)), // 3
  botChanged(BOT_B, "idle", "working"), // 4
  taskChanged(TASK_A, "planning", "running"), // 5
  usageEvent(TASK_C, BOT_D, usage(1000, 100, 0.5)), // 6
  botChanged(BOT_B, "working", "idle"), // 7
  taskChanged(TASK_A, "running", "done"), // 8
  usageEvent(TASK_C, BOT_B, usage(50, 5, 0.25)), // 9
  taskChanged(TASK_C, "received", "failed"), // 10
]

const loadAll = Effect.gen(function* () {
  const beacon = yield* Beacon
  return yield* Stream.runCollect(beacon.readAll())
})

const inStream = (events: ReadonlyArray<Event>, streamId: string): ReadonlyArray<Event> =>
  events.filter((event) => event.streamId === streamId)

// Runs `body` against a fresh in-memory log holding the fixture.
const withFixture = <A, E>(body: Effect.Effect<A, E, Beacon>) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.appendMany(FIXTURE)
    return yield* body
  }).pipe(Effect.provide(BeaconTest))

describe("projections", () => {
  it.effect("taskState is the last state_changed.to of the task stream", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        expect(taskState(inStream(events, streamIds.task(TASK_A)))).toBe("done")
        expect(taskState(inStream(events, streamIds.task(TASK_C)))).toBe("failed")
      }),
    ),
  )

  it.effect("taskState is undefined without state_changed events", () =>
    Effect.sync(() => {
      expect(taskState([])).toBeUndefined()
    }),
  )

  it.effect("botState is the last bot.state_changed.to of the bot stream", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        expect(botState(inStream(events, streamIds.bot(BOT_B)))).toBe("idle")
      }),
    ),
  )

  it.effect("costByTask sums usage.recorded per task", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        const totals = costByTask(events)
        expect(totals.size).toBe(2)
        expect(totals.get(TASK_A)?.tokensIn).toBe(300)
        expect(totals.get(TASK_A)?.tokensOut).toBe(30)
        expect(totals.get(TASK_A)?.usd).toBeCloseTo(0.03, 10)
        expect(totals.get(TASK_C)?.usd).toBeCloseTo(0.75, 10)
      }),
    ),
  )

  it.effect("costByBot sums usage.recorded per bot", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        const totals = costByBot(events)
        expect(totals.get(BOT_B)?.usd).toBeCloseTo(0.28, 10)
        expect(totals.get(BOT_D)?.usd).toBeCloseTo(0.5, 10)
      }),
    ),
  )

  it.effect("latestPerStream keeps the highest log position per stream", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        const latest = latestPerStream(events)
        expect(latest.size).toBe(3)
        expect(latest.get(streamIds.task(TASK_A))?.position).toBe(8)
        expect(latest.get(streamIds.task(TASK_C))?.position).toBe(10)
      }),
    ),
  )

  it.effect("readTaskState and readCostByTask read the log through Beacon", () =>
    withFixture(
      Effect.gen(function* () {
        expect(yield* readTaskState(TASK_A)).toBe("done")
        const totals = yield* readCostByTask()
        expect(totals.get(TASK_C)?.usd).toBeCloseTo(0.75, 10)
      }),
    ),
  )

  it.effect("the fixture holds exactly ten events", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        expect(events).toHaveLength(10)
      }),
    ),
  )
  it.effect("usageForBotSince counts only the Bot's usage inside the window", () =>
    withFixture(
      Effect.gen(function* () {
        const events = yield* loadAll
        // Every fixture event is recorded now: a window starting in the future holds nothing.
        expect(usageForBotSince(events, BOT_B, 0).usd).toBeCloseTo(0.28, 10)
        expect(usageForBotSince(events, BOT_B, Date.now() + 3_600_000).usd).toBe(0)
        // Usage older than the window is left out, even when it sits in the log.
        const first = events[1]
        if (first === undefined) return expect.fail("fixture holds ten events")
        const old: Event = {
          ...first,
          occurredAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-10-18T00:00:00.000Z"),
        }
        const since = Date.parse("2026-10-19T00:00:00.000Z")
        expect(usageForBotSince([old, ...events.slice(2)], BOT_B, since).usd).toBeCloseTo(0.27, 10)
      }),
    ),
  )

  it.effect("readUsageForBotSince reads the Bot's usage from the log", () =>
    withFixture(
      Effect.gen(function* () {
        const usage = yield* readUsageForBotSince(BOT_B, 0)
        expect(usage.tokensIn).toBe(350)
        expect(usage.usd).toBeCloseTo(0.28, 10)
      }),
    ),
  )
})
