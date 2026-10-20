import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { NewTide, Tide, tideShapeIssue } from "../src/tide.js"

const TEMPLATE = {
  title: "Check",
  prompt: "Look",
  kind: "research",
  tier: "light",
  budget: { tokens: 500, seconds: 300, usd: 0.5 },
}

const cron = {
  id: "tide_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  name: "morning",
  kind: "cron",
  cronExpr: "0 9 * * 1-5",
  timezone: "America/Sao_Paulo",
  cooldownSeconds: 60,
  maxFiresPerHour: 30,
  taskTemplate: TEMPLATE,
  enabled: true,
}

describe("tide", () => {
  it("Tide round-trips and defaults the timezone to UTC", () => {
    const { timezone: _timezone, ...withoutZone } = cron
    const decoded = Schema.decodeUnknownSync(Tide)(withoutZone)
    expect(decoded.timezone).toBe("UTC")
    expect(Schema.encodeSync(Tide)(Schema.decodeUnknownSync(Tide)(cron))).toEqual(cron)
  })

  it("rejects a filter value that is not a primitive, and a name with a space", () => {
    const event = { ...cron, kind: "event", cronExpr: undefined, eventType: "message.inbound" }
    expect(() =>
      Schema.decodeUnknownSync(NewTide)({ ...event, eventFilter: { "payload.x": { nested: true } } }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(NewTide)({ ...cron, name: "two words" })).toThrow()
  })

  it("tideShapeIssue names a cron tide without expression and an event tide without type", () => {
    expect(tideShapeIssue({ kind: "cron", cronExpr: undefined })).toBeDefined()
    expect(tideShapeIssue({ kind: "cron", cronExpr: "* * * * *" })).toBeUndefined()
    expect(tideShapeIssue({ kind: "event", eventType: undefined })).toBeDefined()
    expect(tideShapeIssue({ kind: "event", eventType: "message.inbound" })).toBeUndefined()
    expect(
      tideShapeIssue({ kind: "cron", cronExpr: "* * * * *", eventType: "message.inbound" }),
    ).toBeDefined()
  })

  it("an event tide on a feedback type needs a filter, and a default limit applies", () => {
    expect(tideShapeIssue({ kind: "event", eventType: "error.raised" })).toBeDefined()
    expect(tideShapeIssue({ kind: "event", eventType: "error.raised", eventFilter: {} })).toBeDefined()
    expect(
      tideShapeIssue({ kind: "event", eventType: "error.raised", eventFilter: { "payload.where": "x" } }),
    ).toBeUndefined()
    const decoded = Schema.decodeUnknownSync(Tide)(cron)
    expect(decoded.cooldownSeconds).toBe(60)
    expect(decoded.maxFiresPerHour).toBe(30)
  })
})
