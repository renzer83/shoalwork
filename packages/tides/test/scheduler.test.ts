import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { nextRunAfter } from "../src/index.js"

// Every run of the expression in [from, to], walked one run at a time from the stored next-run calculation.
const runsBetween = (expr: string, timezone: string, from: Date, to: Date): Array<string> => {
  const runs: Array<string> = []
  let cursor = from
  for (let step = 0; step < 100; step++) {
    const next = Option.getOrUndefined(nextRunAfter(expr, timezone, cursor))
    if (next === undefined || next.getTime() > to.getTime()) break
    runs.push(next.toISOString())
    cursor = next
  }
  return runs
}

describe("nextRunAfter", () => {
  it("is strictly after the given instant and honours the timezone", () => {
    // 09:00 in São Paulo (UTC-3) is 12:00 UTC.
    const next = nextRunAfter("0 9 * * *", "America/Sao_Paulo", new Date("2026-10-20T00:00:00Z"))
    expect(Option.getOrUndefined(next)?.toISOString()).toBe("2026-10-20T12:00:00.000Z")
    const after = nextRunAfter("0 9 * * *", "America/Sao_Paulo", new Date("2026-10-20T12:00:00Z"))
    expect(Option.getOrUndefined(after)?.toISOString()).toBe("2026-10-21T12:00:00.000Z")
  })

  it("is none for an expression that is not valid and for an unknown timezone", () => {
    expect(Option.isNone(nextRunAfter("not a cron", "UTC", new Date()))).toBe(true)
    expect(Option.isNone(nextRunAfter("0 9 * * *", "Mars/Olympus", new Date()))).toBe(true)
  })
})

describe("daylight saving time (Europe/Lisbon)", () => {
  it("fires a daily 02:30 once on the day the clocks go forward, which has no 02:30", () => {
    // Local day 29 March 2026 runs from 23:00Z on the 28th to 22:59Z on the 29th (WET, then WEST).
    const runs = runsBetween(
      "30 2 * * *",
      "Europe/Lisbon",
      new Date("2026-03-28T22:59:59Z"),
      new Date("2026-03-29T22:59:59Z"),
    )
    expect(runs).toHaveLength(1)
  })

  it("fires a daily 02:30 once on the day the clocks go back, where 02:30 happens twice", () => {
    const runs = runsBetween(
      "30 2 * * *",
      "Europe/Lisbon",
      new Date("2026-10-24T22:59:59Z"),
      new Date("2026-10-25T23:00:00Z"),
    )
    expect(runs).toHaveLength(1)
  })
})
