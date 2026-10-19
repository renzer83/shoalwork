import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Approval, ApprovalStatus, PolicyDecision, PolicyEffect, PolicyRule } from "../src/policy.js"

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const APR = "apr_5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"
const REQUESTED = "2026-10-19T12:00:00.000Z"
const EXPIRES = "2026-10-19T14:00:00.000Z"
const ACTION = { tool: "shell", input: { cmd: "git push" } }

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, raw: unknown): unknown =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(raw))

const APPROVAL = {
  id: APR,
  taskId: TASK,
  botId: BOT,
  action: ACTION,
  risk: "external",
  status: "pending",
  requestedAt: REQUESTED,
  expiresAt: EXPIRES,
}

describe("policy contracts", () => {
  it("PolicyEffect is exactly allow, ask, deny", () => {
    expect(roundTrip(PolicyEffect, "ask")).toBe("ask")
    expect(() => Schema.decodeUnknownSync(PolicyEffect)("maybe")).toThrow()
  })

  it("PolicyRule round-trips with a concrete bot and a glob resource", () => {
    const rule = { bot: BOT, tool: "shell", resource: "git *", effect: "ask", reason: "needs review" }
    expect(roundTrip(PolicyRule, rule)).toEqual(rule)
  })

  it("PolicyRule round-trips with the wildcard bot and tool", () => {
    const rule = { bot: "*", tool: "*", effect: "deny" }
    expect(roundTrip(PolicyRule, rule)).toEqual(rule)
  })

  it("PolicyRule rejects a bot that is neither a BotId nor the wildcard", () => {
    expect(() => Schema.decodeUnknownSync(PolicyRule)({ bot: "renan", tool: "*", effect: "allow" })).toThrow()
  })

  it("PolicyRule rejects an effect outside allow, ask, deny", () => {
    expect(() => Schema.decodeUnknownSync(PolicyRule)({ bot: "*", tool: "*", effect: "log" })).toThrow()
  })

  it("PolicyDecision round-trips with the matched rule", () => {
    const decision = {
      effect: "ask",
      rule: { bot: "*", tool: "shell", effect: "ask" },
      risk: "irreversible",
    }
    expect(roundTrip(PolicyDecision, decision)).toEqual(decision)
  })

  it("PolicyDecision round-trips without a matched rule", () => {
    const decision = { effect: "allow", risk: "read" }
    expect(roundTrip(PolicyDecision, decision)).toEqual(decision)
  })

  it("PolicyDecision rejects a risk outside the closed list", () => {
    expect(() =>
      Schema.decodeUnknownSync(PolicyDecision)({ effect: "allow", risk: "catastrophic" }),
    ).toThrow()
  })

  it("ApprovalStatus is exactly pending, approved, denied, expired", () => {
    for (const status of ["pending", "approved", "denied", "expired"]) {
      expect(roundTrip(ApprovalStatus, status)).toBe(status)
    }
    expect(() => Schema.decodeUnknownSync(ApprovalStatus)("cancelled")).toThrow()
  })

  it("Approval round-trips a pending approval with ISO dates", () => {
    expect(roundTrip(Approval, APPROVAL)).toEqual(APPROVAL)
  })

  it("Approval round-trips a resolved approval with resolvedAt and resolvedBy", () => {
    const resolved = {
      ...APPROVAL,
      status: "approved",
      resolvedAt: "2026-10-19T12:05:00.000Z",
      resolvedBy: "user:renan",
    }
    expect(roundTrip(Approval, resolved)).toEqual(resolved)
  })

  it("Approval with expiresAt before requestedAt still decodes (the temporal rule belongs to the policy)", () => {
    const inverted = { ...APPROVAL, expiresAt: "2026-10-19T10:00:00.000Z" }
    expect(roundTrip(Approval, inverted)).toEqual(inverted)
  })

  it("Approval rejects a status outside the closed list", () => {
    expect(() => Schema.decodeUnknownSync(Approval)({ ...APPROVAL, status: "cancelled" })).toThrow()
  })

  it("Approval rejects a requestedAt that is not a date", () => {
    expect(() => Schema.decodeUnknownSync(Approval)({ ...APPROVAL, requestedAt: "yesterday" })).toThrow()
  })

  it("Approval rejects an action without a tool name", () => {
    expect(() => Schema.decodeUnknownSync(Approval)({ ...APPROVAL, action: { input: {} } })).toThrow()
  })
})
