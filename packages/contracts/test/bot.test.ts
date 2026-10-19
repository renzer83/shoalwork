import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Bot, NewBot } from "../src/bot.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

describe("bot", () => {
  it("Bot round-trips the fixture", () => {
    const raw = fixture("bot.json")
    expect(Schema.encodeSync(Bot)(Schema.decodeUnknownSync(Bot)(raw))).toEqual(raw)
  })

  it("NewBot round-trips a Bot without id", () => {
    const raw = fixture("new-bot.json")
    expect(Schema.encodeSync(NewBot)(Schema.decodeUnknownSync(NewBot)(raw))).toEqual(raw)
  })

  it("Bot rejects a payload without id", () => {
    expect(() => Schema.decodeUnknownSync(Bot)(fixture("new-bot.json"))).toThrow()
  })

  it("rejects a bot name containing a space", () => {
    const raw = { ...(fixture("new-bot.json") as object), name: "code reviewer" }
    expect(() => Schema.decodeUnknownSync(NewBot)(raw)).toThrow()
  })

  it("rejects a bot name longer than 31 characters", () => {
    const raw = { ...(fixture("new-bot.json") as object), name: "a".repeat(32) }
    expect(() => Schema.decodeUnknownSync(NewBot)(raw)).toThrow()
  })

  it("rejects empty instructions", () => {
    const raw = { ...(fixture("new-bot.json") as object), instructions: "" }
    expect(() => Schema.decodeUnknownSync(NewBot)(raw)).toThrow()
  })

  it("accepts modelTiers with only one tier overridden", () => {
    const raw = {
      ...(fixture("new-bot.json") as object),
      modelTiers: { heavy: { executor: "codex", model: "gpt" } },
    }
    const decoded = Schema.decodeUnknownSync(NewBot)(raw)
    expect(decoded.modelTiers).toEqual({ heavy: { executor: "codex", model: "gpt" } })
  })

  it("rejects a tier with an invalid effort literal", () => {
    const raw = {
      ...(fixture("new-bot.json") as object),
      modelTiers: { chat: { executor: "codex", model: "gpt", effort: "extreme" } },
    }
    expect(() => Schema.decodeUnknownSync(NewBot)(raw)).toThrow()
  })
})
