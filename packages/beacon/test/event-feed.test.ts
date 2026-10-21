import type { Event } from "@shoalwork/contracts"
import { describe, expect, it } from "vitest"
import { type CostWindow, costReport, eventFeed } from "../src/index.js"
import {
  decisionEvent,
  finishedEvent,
  receivedEvent,
  TASK_1,
  TASK_2,
  TASK_3,
  usageEvent,
} from "./farol-fixtures.js"

const WINDOW: CostWindow = {
  since: Date.parse("2026-10-10T00:00:00Z"),
  until: Date.parse("2026-10-13T00:00:00Z"),
}
const AT = "2026-10-11T12:00:00.000Z"

const positions = (events: ReadonlyArray<Event>): ReadonlyArray<number> =>
  events.map((event) => event.position)

describe("eventFeed", () => {
  // Positions 1..5 in log order: the decisions are 1, 3 and 5; the usage is 2 and 4.
  const log = [
    decisionEvent(TASK_1, "rule", AT),
    usageEvent(TASK_2, "claude-haiku-5-5", 10, 0.01, AT),
    decisionEvent(TASK_1, "model", AT),
    usageEvent(TASK_3, "claude-sonnet-5", 20, 0.02, AT),
    decisionEvent(TASK_2, "cache", AT),
  ]

  it("matches q case-insensitively against the type and the payload text", () => {
    expect(positions(eventFeed(log, { q: "CLAUDE-HAIKU" }, { limit: 10 }).events)).toEqual([2])
    expect(positions(eventFeed(log, { q: "decision.made" }, { limit: 10 }).events)).toEqual([5, 3, 1])
    expect(positions(eventFeed(log, { q: "no-such-text" }, { limit: 10 }).events)).toEqual([])
  })

  it("filters by actor and stream", () => {
    expect(positions(eventFeed(log, { actor: "system:test" }, { limit: 10 }).events)).toEqual([5, 4, 3, 2, 1])
    expect(positions(eventFeed(log, { actor: "someone" }, { limit: 10 }).events)).toEqual([])
    const stream = log[1]?.streamId
    // TASK_2 owns positions 2 and 5.
    expect(positions(eventFeed(log, { stream }, { limit: 10 }).events)).toEqual([5, 2])
  })

  it("pages newest first with an exclusive before cursor until the log runs out", () => {
    const first = eventFeed(log, {}, { limit: 2 })
    expect(positions(first.events)).toEqual([5, 4])
    expect(first.nextBefore).toBe(4)

    const second = eventFeed(log, {}, { limit: 2, before: first.nextBefore ?? undefined })
    expect(positions(second.events)).toEqual([3, 2])
    expect(second.nextBefore).toBe(2)

    const last = eventFeed(log, {}, { limit: 2, before: second.nextBefore ?? undefined })
    expect(positions(last.events)).toEqual([1])
    expect(last.nextBefore).toBeNull()
  })

  it("has no next page when the page is exactly full", () => {
    const page = eventFeed(log, {}, { limit: 5 })
    expect(page.events).toHaveLength(5)
    expect(page.nextBefore).toBeNull()
  })
})

describe("costReport by tier", () => {
  it("groups cost by the tier of each task, unknown when its task.received is not in the events", () => {
    const events = [
      receivedEvent(TASK_1, "heavy", AT),
      receivedEvent(TASK_2, "light", AT),
      usageEvent(TASK_1, "claude-opus-5", 100, 0.5, AT),
      usageEvent(TASK_1, "claude-opus-5", 100, 0.5, AT),
      usageEvent(TASK_2, "claude-haiku-5-5", 50, 0.1, AT),
      finishedEvent(TASK_1, AT),
      finishedEvent(TASK_3, AT),
    ]
    const report = costReport(events, { current: WINDOW }, "tier")
    expect(report.rows.map((row) => [row.key, row.n, row.usd])).toEqual([
      ["heavy", 1, 1],
      ["light", 0, 0.1],
      ["unknown", 1, 0],
    ])
  })
})
