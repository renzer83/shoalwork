import { it } from "@effect/vitest"
import { BotId, Event, type EventType, streamIds, TaskId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  Beacon,
  BeaconTest,
  type CostBy,
  type CostWindow,
  costDelta,
  costReport,
  readCostEvents,
} from "../src/index.js"

const TASK_1 = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK_2 = Schema.decodeUnknownSync(TaskId)("task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
const TASK_3 = Schema.decodeUnknownSync(TaskId)("task_2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f")
const TASK_4 = Schema.decodeUnknownSync(TaskId)("task_3d4e5f6a-7b8c-4d9e-9f01-2b3c4d5e6f70")
const BOT_B = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const BOT_D = Schema.decodeUnknownSync(BotId)("bot_4a3b2c1d-9e8f-4a7b-8c6d-5e4f3a2b1c0d")

const BASELINE: CostWindow = {
  since: Date.parse("2026-10-01T00:00:00Z"),
  until: Date.parse("2026-10-08T00:00:00Z"),
}
const CURRENT: CostWindow = {
  since: Date.parse("2026-10-08T00:00:00Z"),
  until: Date.parse("2026-10-12T00:00:00Z"),
}

let counter = 0

// Built through the Event schema, so the fixture is checked the way the log is. occurredAt is the given instant.
const stored = (type: EventType, taskId: TaskId, payload: unknown, occurredAt: string): Event => {
  counter += 1
  return Schema.decodeUnknownSync(Event)({
    id: `evt_00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    streamId: streamIds.task(taskId),
    version: counter,
    position: counter,
    type,
    payload,
    actor: "system:test",
    correlationId: "corr_cost_window",
    occurredAt,
  })
}

const verdict = (kind: string) => ({
  kind,
  summary: "s",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
})

const started = (taskId: TaskId, botId: BotId, executor: string, at: string) =>
  stored(
    "executor.started",
    taskId,
    { taskId, botId, executor, model: "claude-haiku-5-5", cwd: "/tmp/w" },
    at,
  )

const finished = (taskId: TaskId, botId: BotId, kind: string, at: string) =>
  stored("executor.finished", taskId, { taskId, botId, verdict: verdict(kind), durationMs: 1000 }, at)

const spend = (
  taskId: TaskId,
  botId: BotId,
  executor: string,
  tokensIn: number,
  tokensOut: number,
  usd: number,
  at: string,
) =>
  stored(
    "usage.recorded",
    taskId,
    {
      taskId,
      botId,
      executor,
      model: "claude-haiku-5-5",
      usage: { tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, usd, seconds: 1 },
    },
    at,
  )

const context = (taskId: TaskId, used: number, at: string) =>
  stored("context.assembled", taskId, { taskId, level: "full", used, budget: 6000, dropped: [] }, at)

// Log order is position order. Events outside both windows (09-30, 10-13) must never be counted.
const FIXTURE: ReadonlyArray<Event> = [
  spend(TASK_1, BOT_B, "claude-code", 5000, 0, 0, "2026-09-30T00:00:00Z"),
  started(TASK_1, BOT_B, "claude-code", "2026-10-03T10:00:00Z"),
  context(TASK_1, 800, "2026-10-03T10:00:01Z"),
  spend(TASK_1, BOT_B, "claude-code", 1000, 100, 0.1, "2026-10-03T10:00:05Z"),
  finished(TASK_1, BOT_B, "ok", "2026-10-03T10:00:06Z"),
  started(TASK_1, BOT_B, "claude-code", "2026-10-04T10:00:00Z"),
  spend(TASK_1, BOT_B, "claude-code", 1000, 100, 0.1, "2026-10-04T10:00:05Z"),
  finished(TASK_1, BOT_B, "failed", "2026-10-04T10:00:06Z"),
  // Exactly on `since` of the current window: counted there, and not in the baseline (until is exclusive).
  spend(TASK_3, BOT_B, "claude-code", 300, 30, 0.02, "2026-10-08T00:00:00.000Z"),
  context(TASK_3, 200, "2026-10-08T00:00:00.000Z"),
  finished(TASK_3, BOT_B, "ok", "2026-10-08T00:00:01Z"),
  started(TASK_2, BOT_D, "codex", "2026-10-09T10:00:00Z"),
  context(TASK_2, 400, "2026-10-09T10:00:01Z"),
  spend(TASK_2, BOT_D, "codex", 500, 50, 0.05, "2026-10-09T10:00:05Z"),
  finished(TASK_2, BOT_D, "ok", "2026-10-09T10:00:06Z"),
  started(TASK_2, BOT_D, "codex", "2026-10-09T11:00:00Z"),
  context(TASK_2, 400, "2026-10-09T11:00:01Z"),
  spend(TASK_2, BOT_D, "codex", 500, 50, 0.05, "2026-10-09T11:00:05Z"),
  finished(TASK_2, BOT_D, "ok", "2026-10-09T11:00:06Z"),
  // No started and no usage in the window: the executor is "unknown".
  finished(TASK_4, BOT_D, "failed", "2026-10-10T10:00:00Z"),
  spend(TASK_2, BOT_D, "codex", 9999, 0, 9, "2026-10-13T00:00:00Z"),
]

const report = (by: CostBy, baseline: CostWindow | undefined = BASELINE) =>
  costReport(FIXTURE, { current: CURRENT, baseline }, by)

describe("costReport over a fixture of the log", () => {
  it("groups the current window by task, with n, tokens, usd, context mean and okRate", () => {
    const rows = report("task").rows
    expect(rows.map((row) => row.key)).toEqual([TASK_2, TASK_3, TASK_4])
    const task2 = rows[0]
    expect(task2).toMatchObject({ n: 2, tokensIn: 1000, tokensOut: 100, contextTokensAvg: 400, okRate: 1 })
    expect(task2?.usd).toBeCloseTo(0.1, 10)
    expect(rows[1]).toMatchObject({ key: TASK_3, n: 1, tokensIn: 300, contextTokensAvg: 200, okRate: 1 })
    expect(rows[2]).toMatchObject({ key: TASK_4, n: 1, tokensIn: 0, contextTokensAvg: null, okRate: 0 })
  })

  it("groups by bot, attributing context through the task's bot", () => {
    const rows = report("bot").rows
    expect(rows.map((row) => row.key)).toEqual([BOT_D, BOT_B])
    expect(rows[0]).toMatchObject({ n: 3, tokensIn: 1000, contextTokensAvg: 400 })
    expect(rows[0]?.okRate).toBeCloseTo(2 / 3, 10)
    expect(rows[1]).toMatchObject({ n: 1, tokensIn: 300, contextTokensAvg: 200, okRate: 1 })
  })

  it("groups by executor: started executor, usage executor as fallback, unknown otherwise", () => {
    const rows = report("executor").rows
    expect(rows.map((row) => row.key)).toEqual(["codex", "claude-code", "unknown"])
    expect(rows[0]).toMatchObject({ n: 2, tokensIn: 1000, contextTokensAvg: 400, okRate: 1 })
    expect(rows[1]).toMatchObject({ n: 1, tokensIn: 300, contextTokensAvg: 200, okRate: 1 })
    expect(rows[2]).toMatchObject({ n: 1, tokensIn: 0, contextTokensAvg: null, okRate: 0 })
  })

  it("computes the delta against the baseline window: tokensIn per execution and okRate in points", () => {
    const { delta } = report("task")
    // current: 1300 tokens over 4 executions = 325; baseline: 2000 over 2 = 1000.
    expect(delta.tokensInPct).toBeCloseTo(-67.5, 10)
    // current okRate 3/4, baseline 1/2: +25 percentage points.
    expect(delta.okRatePct).toBeCloseTo(25, 10)
  })

  it("leaves the delta null without a baseline", () => {
    expect(costReport(FIXTURE, { current: CURRENT }, "task").delta).toEqual({
      tokensInPct: null,
      okRatePct: null,
    })
  })

  it("leaves the delta null when the baseline has no executions (no division by zero)", () => {
    const empty: CostWindow = {
      since: Date.parse("2025-01-01T00:00:00Z"),
      until: Date.parse("2025-02-01T00:00:00Z"),
    }
    expect(report("task", empty).delta).toEqual({ tokensInPct: null, okRatePct: null })
  })

  it("returns no rows for a window with no events", () => {
    const far: CostWindow = {
      since: Date.parse("2030-01-01T00:00:00Z"),
      until: Date.parse("2030-02-01T00:00:00Z"),
    }
    const result = costReport(FIXTURE, { current: far }, "task")
    expect(result).toEqual({ rows: [], delta: { tokensInPct: null, okRatePct: null } })
  })
})

describe("costDelta", () => {
  it("returns null tokensInPct when the baseline tokens per execution is zero", () => {
    const delta = costDelta({ n: 2, tokensIn: 100, okRate: 1 }, { n: 2, tokensIn: 0, okRate: 1 })
    expect(delta).toEqual({ tokensInPct: null, okRatePct: 0 })
  })

  it("returns null okRatePct when one side has no terminated execution", () => {
    const delta = costDelta({ n: 0, tokensIn: 100, okRate: null }, { n: 2, tokensIn: 100, okRate: 0.5 })
    expect(delta).toEqual({ tokensInPct: null, okRatePct: null })
  })
})

describe("readCostEvents", () => {
  it.effect("reads only the four cost types through Beacon", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany([
        {
          streamId: streamIds.system,
          type: "control.changed",
          payload: { scope: "global", action: "pause", by: "user:renan", tasks: [] },
          actor: "user:renan",
          correlationId: "corr",
        },
        {
          streamId: streamIds.task(TASK_1),
          type: "usage.recorded",
          payload: {
            taskId: TASK_1,
            botId: BOT_B,
            executor: "claude-code",
            model: "m",
            usage: { tokensIn: 7, tokensOut: 1, cacheRead: 0, cacheWrite: 0, usd: 0, seconds: 1 },
          },
          actor: "system:test",
          correlationId: "corr",
        },
      ])
      const events = yield* readCostEvents()
      expect(events.map((event) => event.type)).toEqual(["usage.recorded"])
    }).pipe(Effect.provide(BeaconTest)),
  )
})
