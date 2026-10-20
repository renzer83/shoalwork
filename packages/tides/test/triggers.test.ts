import { type Event, Event as EventSchema, streamIds } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { isBotOwnEvent, isFeedback, optsInToBotOwn } from "../src/index.js"

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

const botOwn = (payload: unknown): Event =>
  Schema.decodeUnknownSync(EventSchema)({
    id: "evt_4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d",
    streamId: streamIds.system,
    version: 1,
    position: 2,
    type: "github.pull_request",
    payload,
    actor: "github:renzer83",
    correlationId: "corr_bot_own",
    occurredAt: "2026-10-20T10:00:00.000Z",
  })

describe("the Bot's own GitHub work", () => {
  it("is feedback, so a Tide reacts to it only when its filter names the flag", () => {
    const own = botOwn({ botAuthored: true, repo: "a/b" })
    expect(isBotOwnEvent(own)).toBe(true)
    expect(isFeedback(own)).toBe(true)
    expect(optsInToBotOwn({ eventFilter: undefined }, own)).toBe(false)
    expect(optsInToBotOwn({ eventFilter: { "payload.repo": "a/b" } }, own)).toBe(false)
    expect(optsInToBotOwn({ eventFilter: { "payload.botAuthored": false } }, own)).toBe(false)
    expect(optsInToBotOwn({ eventFilter: { "payload.botAuthored": true } }, own)).toBe(true)
  })

  it("is not feedback for others' work, and needs no opt-in", () => {
    const others = botOwn({ botAuthored: false, repo: "a/b" })
    expect(isBotOwnEvent(others)).toBe(false)
    expect(isFeedback(others)).toBe(false)
    expect(optsInToBotOwn({ eventFilter: undefined }, others)).toBe(true)
  })
})
