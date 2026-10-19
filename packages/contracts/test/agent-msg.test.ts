import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AgentMsg } from "../src/agent-msg.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const BOT_ID = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"

describe("agent-msg", () => {
  it("every AgentMsg fixture round-trips", () => {
    const raw = fixture("agent-msg.json")
    expect(
      Schema.encodeSync(Schema.Array(AgentMsg))(Schema.decodeUnknownSync(Schema.Array(AgentMsg))(raw)),
    ).toEqual(raw)
  })

  it("decodes the three kinds into the union", () => {
    const decoded = Schema.decodeUnknownSync(Schema.Array(AgentMsg))(fixture("agent-msg.json"))
    expect(decoded.map((m) => m.kind)).toEqual(["handoff", "result", "status"])
  })

  it("rejects a message with an unknown kind", () => {
    expect(() => Schema.decodeUnknownSync(AgentMsg)({ kind: "broadcast", bot: BOT_ID })).toThrow()
  })

  it("rejects a status message with a bot state outside the closed list", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentMsg)({ kind: "status", bot: BOT_ID, state: "sleeping" }),
    ).toThrow()
  })
})
