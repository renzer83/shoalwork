import { type BotId, Event, type EventType, streamIds, TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  type ContextRun,
  type CostWindow,
  contextDelta,
  contextMetrics,
  contextRuns,
  contextTotals,
} from "../src/index.js"

const BOT = Schema.decodeUnknownSync(Schema.String)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41") as BotId
const BEFORE: CostWindow = {
  since: Date.parse("2026-10-01T00:00:00Z"),
  until: Date.parse("2026-10-08T00:00:00Z"),
}
const AFTER: CostWindow = {
  since: Date.parse("2026-10-08T00:00:00Z"),
  until: Date.parse("2026-10-15T00:00:00Z"),
}

let counter = 0
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
    correlationId: "corr_context_metrics",
    occurredAt,
  })
}

const taskIdOf = (n: number): TaskId =>
  Schema.decodeUnknownSync(TaskId)(`task_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`)

const verdict = (kind: string) => ({
  kind,
  summary: "s",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
})

// One run of task `n`: context.assembled, executor.started, usage.recorded, executor.finished (ok unless n % 5 === 0).
const run = (n: number, level: string, used: number, tokensIn: number, at: string): ReadonlyArray<Event> => {
  const taskId = taskIdOf(n)
  return [
    stored("context.assembled", taskId, { taskId, level, used, budget: 4000, dropped: [] }, at),
    stored(
      "executor.started",
      taskId,
      { taskId, botId: BOT, executor: "claude-code", model: "haiku", cwd: "/w" },
      at,
    ),
    stored(
      "usage.recorded",
      taskId,
      {
        taskId,
        botId: BOT,
        executor: "claude-code",
        model: "haiku",
        usage: { tokensIn, tokensOut: 100, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 5 },
      },
      at,
    ),
    stored(
      "executor.finished",
      taskId,
      { taskId, botId: BOT, verdict: verdict(n % 5 === 0 ? "failed" : "ok"), durationMs: 1000 },
      at,
    ),
  ]
}

// 20 tasks: 10 before (tokensIn 1000 each) and 10 after (tokensIn 100..1000, average 550, nearest-rank p90 900).
// Both sides have 8 ok verdicts out of 10. One extra finished in the after window has no started: unpaired.
const FIXTURE: ReadonlyArray<Event> = [
  ...Array.from({ length: 10 }, (_, i) =>
    run(i + 1, i % 2 === 0 ? "top3" : "full", 1000, 1000, "2026-10-02T12:00:00.000Z"),
  ).flat(),
  ...Array.from({ length: 10 }, (_, i) =>
    run(i + 11, i % 2 === 0 ? "top3" : "full", 600, (i + 1) * 100, "2026-10-09T12:00:00.000Z"),
  ).flat(),
  stored(
    "executor.finished",
    taskIdOf(99),
    { taskId: taskIdOf(99), botId: BOT, verdict: verdict("ok"), durationMs: 1000 },
    "2026-10-09T13:00:00.000Z",
  ),
]

describe("context metrics over a fixture of 20 tasks", () => {
  it("pairs 10 runs per window and counts the unpaired finish", () => {
    const before = contextRuns(FIXTURE, BEFORE)
    const after = contextRuns(FIXTURE, AFTER)
    expect(before.runs.length).toBe(10)
    expect(before.unpaired).toBe(0)
    expect(after.runs.length).toBe(10)
    expect(after.unpaired).toBe(1)
  })

  it("gives the expected delta: tokensIn per execution -45%, okRate unchanged", () => {
    const beforeTotals = contextTotals(contextRuns(FIXTURE, BEFORE).runs)
    const afterTotals = contextTotals(contextRuns(FIXTURE, AFTER).runs)
    expect(beforeTotals).toEqual({ n: 10, tokensInAvg: 1000, okRate: 0.8 })
    expect(afterTotals.n).toBe(10)
    expect(afterTotals.tokensInAvg).toBeCloseTo(550, 9)
    expect(afterTotals.okRate).toBe(0.8)
    const delta = contextDelta(afterTotals, beforeTotals)
    expect(delta.tokensInAvgPct).toBeCloseTo(-45, 9)
    expect(delta.okRatePct).toBeCloseTo(0, 9)
  })

  it("groups by level with p90, context average and okRate per key", () => {
    const rows = contextMetrics(FIXTURE, {
      since: new Date(AFTER.since),
      until: new Date(AFTER.until),
      by: "level",
    })
    expect(rows.map((row) => row.key)).toEqual(["full", "top3"])
    // Odd i (full): tokensIn 200, 400, 600, 800, 1000 -> avg 600, p90 1000. Even i (top3): 100..900 -> avg 500, p90 900.
    const full = rows.find((row) => row.key === "full")
    const top3 = rows.find((row) => row.key === "top3")
    expect(full).toEqual({
      key: "full",
      n: 5,
      tokensInAvg: 600,
      tokensInP90: 1000,
      contextTokensAvg: 600,
      okRate: 0.8,
    })
    expect(top3).toEqual({
      key: "top3",
      n: 5,
      tokensInAvg: 500,
      tokensInP90: 900,
      contextTokensAvg: 600,
      okRate: 0.8,
    })
  })

  it("groups by task with one run per key", () => {
    const rows = contextMetrics(FIXTURE, {
      since: new Date(AFTER.since),
      until: new Date(AFTER.until),
      by: "task",
    })
    expect(rows.length).toBe(10)
    expect(rows.every((row) => row.n === 1)).toBe(true)
  })

  it("keeps the context average null when no context.assembled was recorded", () => {
    const withoutContext: ReadonlyArray<Event> = FIXTURE.filter((event) => event.type !== "context.assembled")
    const rows = contextMetrics(withoutContext, {
      since: new Date(BEFORE.since),
      until: new Date(BEFORE.until),
      by: "executor",
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.contextTokensAvg).toBeNull()
  })

  it("returns no delta when the baseline has no runs", () => {
    const afterTotals = contextTotals(contextRuns(FIXTURE, AFTER).runs)
    const empty = contextTotals([] as ReadonlyArray<ContextRun>)
    expect(empty).toEqual({ n: 0, tokensInAvg: null, okRate: null })
    expect(contextDelta(afterTotals, empty)).toEqual({ tokensInAvgPct: null, okRatePct: null })
  })
})
