import { describe, expect, it } from "vitest"
import { computeMetrics, type MetricEvent } from "../src/baseline.js"

const T0 = "2026-01-01T00:00:00.000Z"
const at = (hours: number): string => new Date(Date.parse(T0) + hours * 3_600_000).toISOString()

const bridgeFixture: ReadonlyArray<MetricEvent> = [
  { taskId: "A", type: "opened", at: at(0) },
  { taskId: "B", type: "opened", at: at(1) },
  { taskId: "B", type: "retry", at: at(1.5) },
  { taskId: "A", type: "merged", at: at(2) },
  { taskId: "B", type: "merged", at: at(3) },
]

// The same timeline expressed with Beacon lifecycle types: computeMetrics must not care about the source taxonomy.
const beaconFixture: ReadonlyArray<MetricEvent> = [
  { taskId: "A", type: "task.received", at: at(0) },
  { taskId: "B", type: "task.received", at: at(1) },
  { taskId: "B", type: "retry", at: at(1.5) },
  { taskId: "A", type: "task.done", at: at(2) },
  { taskId: "B", type: "task.done", at: at(3) },
]

describe("computeMetrics", () => {
  it("scores lead time, idle and retries on a known fixture", () => {
    const metrics = computeMetrics(bridgeFixture)
    // Both tasks merge 2 h after opening.
    expect(metrics.leadTimeMedianMs).toBe(2 * 3_600_000)
    expect(metrics.leadTimeP90Ms).toBe(2 * 3_600_000)
    // Gaps: 1 h + 30 m + 30 m + 1 h = 3 h over 4 transitions -> 2700 s.
    expect(metrics.idleSeconds).toBe(2700)
    // One retry event over two tasks.
    expect(metrics.retriesPerTask).toBe(0.5)
    // No task is left open, so nothing is stuck.
    expect(metrics.stuckPerWeek).toBe(0)
    // Two tasks over the 3 h window (clamped to one day).
    expect(metrics.throughputPerDay).toBe(2)
  })

  it("returns null lead times and zeroed metrics for no events", () => {
    expect(computeMetrics([])).toEqual({
      leadTimeMedianMs: null,
      leadTimeP90Ms: null,
      throughputPerDay: 0,
      idleSeconds: 0,
      retriesPerTask: 0,
      stuckPerWeek: 0,
    })
  })

  it("scores the bridge fixture and the equivalent Beacon fixture identically", () => {
    expect(computeMetrics(bridgeFixture)).toEqual(computeMetrics(beaconFixture))
  })
})
