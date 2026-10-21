import { Event } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  eventsQuery,
  formatPct,
  formatUsd,
  liveMatches,
  PAGE_SIZE,
  parseTypes,
} from "../src/components/beacon/beacon-model.js"

const EVENT: Event = Schema.decodeUnknownSync(Event)({
  id: "evt_00000000-0000-4000-8000-000000000001",
  streamId: "bot:bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  version: 1,
  position: 1,
  type: "usage.recorded",
  payload: { model: "claude-haiku-5-5" },
  actor: "system:test",
  correlationId: "corr",
  occurredAt: "2026-10-21T10:00:00.000Z",
})

describe("beacon model", () => {
  it("separates known event types from the names the core would refuse", () => {
    expect(parseTypes("usage.recorded, nope,usage.recorded")).toEqual({
      types: ["usage.recorded"],
      unknown: ["nope"],
    })
    expect(parseTypes("   ")).toEqual({ types: undefined, unknown: [] })
  })

  it("builds the events query with the window ceiling and the page size", () => {
    const query = eventsQuery({ types: "", stream: " ", actor: "", q: "abc" }, "30d", 9)
    expect(query).toEqual({
      since: "7d",
      types: undefined,
      stream: undefined,
      actor: undefined,
      q: "abc",
      before: 9,
      limit: PAGE_SIZE,
    })
  })

  it("matches live events on the same filters, case-insensitively on the payload", () => {
    expect(liveMatches(EVENT, { types: "", stream: "", actor: "", q: "HAIKU" })).toBe(true)
    expect(liveMatches(EVENT, { types: "decision.made", stream: "", actor: "", q: "" })).toBe(false)
    expect(liveMatches(EVENT, { types: "", stream: "", actor: "someone", q: "" })).toBe(false)
  })

  it("prints null as a dash, not as zero", () => {
    expect(formatUsd(null)).toBe("—")
    expect(formatPct(null)).toBe("—")
    expect(formatPct(12.345)).toBe("12.3%")
  })
})
