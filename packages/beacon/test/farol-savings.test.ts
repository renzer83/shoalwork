import { describe, expect, it } from "vitest"
import { type CostWindow, dailyCost, savings } from "../src/index.js"
import {
  contextEvent,
  decisionEvent,
  finishedEvent,
  TASK_1,
  TASK_2,
  TASK_3,
  usageEvent,
} from "./farol-fixtures.js"

const WINDOW: CostWindow = {
  since: Date.parse("2026-10-10T00:00:00Z"),
  until: Date.parse("2026-10-13T00:00:00Z"),
}
const IN = "2026-10-11T12:00:00.000Z"
const OUT = "2026-10-13T00:00:00.000Z"

describe("savings", () => {
  it("values the local decisions with the Haiku run cost and the compacted tokens with the blended input price", () => {
    const events = [
      decisionEvent(TASK_1, "rule", IN),
      decisionEvent(TASK_1, "rule", IN),
      decisionEvent(TASK_1, "cache", IN),
      decisionEvent(TASK_1, "model", IN),
      usageEvent(TASK_2, "claude-haiku-5-5", 1000, 0.02, IN),
      usageEvent(TASK_2, "claude-haiku-5-5", 3000, 0.04, IN),
      usageEvent(TASK_3, "claude-sonnet-5", 6000, 1.0, IN),
      contextEvent(
        TASK_1,
        [{ block: "memory", items: 3 }],
        [{ block: "code", level: 1, before: 1000, after: 600 }],
        IN,
      ),
      // Outside the window: counted by nobody.
      decisionEvent(TASK_1, "rule", OUT),
      usageEvent(TASK_2, "claude-haiku-5-5", 1000, 9, OUT),
    ]
    const report = savings(events, WINDOW)

    expect(report.decisions).toEqual({ total: 4, rule: 2, cache: 1, model: 1, localPct: 75 })
    expect(report.haikuRuns).toBe(2)
    expect(report.decisionUsd).toBeCloseTo(0.03, 10)
    expect(report.avoidedUsd).toBeCloseTo(3 * 0.03, 10)
    expect(report.context.assembled).toBe(1)
    expect(report.context.tokensBefore).toBe(1000)
    expect(report.context.tokensAfter).toBe(600)
    expect(report.context.tokensCut).toBe(400)
    expect(report.context.cutPct).toBeCloseTo(40, 10)
    expect(report.context.droppedItems).toBe(3)
    // Blended over the in-window usage: (0.02 + 0.04 + 1.0) / (1000 + 3000 + 6000) input tokens.
    expect(report.context.usdPerInputToken).toBeCloseTo(1.06 / 10000, 12)
    expect(report.context.avoidedUsd).toBeCloseTo(400 * (1.06 / 10000), 12)
  })

  it("reports nulls, not zeros, when the window has nothing to value", () => {
    const report = savings([decisionEvent(TASK_1, "model", IN)], WINDOW)
    expect(report.decisions.localPct).toBe(0)
    expect(report.decisionUsd).toBeNull()
    expect(report.avoidedUsd).toBeNull()
    expect(report.context.cutPct).toBeNull()
    expect(report.context.usdPerInputToken).toBeNull()
    expect(report.context.avoidedUsd).toBeNull()
    expect(savings([], WINDOW).decisions.localPct).toBeNull()
  })
})

describe("dailyCost", () => {
  it("returns one zero-filled row per UTC day, oldest first", () => {
    const events = [
      finishedEvent(TASK_1, "2026-10-10T23:59:59.000Z"),
      finishedEvent(TASK_1, "2026-10-11T00:00:00.000Z"),
      finishedEvent(TASK_2, "2026-10-11T08:00:00.000Z"),
      usageEvent(TASK_2, "claude-haiku-5-5", 10, 0.5, "2026-10-12T09:00:00.000Z"),
      finishedEvent(TASK_2, OUT),
    ]
    expect(dailyCost(events, WINDOW)).toEqual([
      { day: "2026-10-10", n: 1, usd: 0 },
      { day: "2026-10-11", n: 2, usd: 0 },
      { day: "2026-10-12", n: 0, usd: 0.5 },
    ])
  })

  it("returns a row for an empty window day", () => {
    expect(dailyCost([], WINDOW).map((row) => row.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"])
  })
})
