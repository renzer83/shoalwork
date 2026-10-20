import { type Event, Event as EventSchema, streamIds } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { isFeedback } from "../src/index.js"

const event = (type: string, actor: string): Event =>
  Schema.decodeUnknownSync(EventSchema)({
    id: "evt_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
    streamId: streamIds.system,
    version: 1,
    position: 1,
    type,
    payload: {},
    actor,
    correlationId: "corr_feedback",
    occurredAt: "2026-10-20T10:00:00.000Z",
  })

describe("feedback guard", () => {
  it("does not take the tides' own events as triggers, nor tide.fired whoever wrote it", () => {
    expect(isFeedback(event("error.raised", "system:tides"))).toBe(true)
    expect(isFeedback(event("budget.exceeded", "system:tides"))).toBe(true)
    expect(isFeedback(event("tide.fired", "system:lead"))).toBe(true)
    expect(isFeedback(event("error.raised", "user:renan"))).toBe(false)
  })
})
