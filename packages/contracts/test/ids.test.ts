import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BotId, newBotId, newTaskId, TaskId } from "../src/ids.js"

const UUID = "3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"

describe("ids", () => {
  it("newBotId generates a value that BotId decodes", () => {
    const id = newBotId()
    expect(Schema.decodeUnknownSync(BotId)(id)).toBe(id)
    expect(id).toMatch(/^bot_[0-9a-f-]{36}$/)
  })

  it("encode(decode(x)) round-trips a BotId", () => {
    const raw = `bot_${UUID}`
    const decoded = Schema.decodeUnknownSync(BotId)(raw)
    expect(Schema.encodeSync(BotId)(decoded)).toBe(raw)
  })

  it("rejects a BotId without a uuid", () => {
    expect(() => Schema.decodeUnknownSync(BotId)("bot_x")).toThrow()
  })

  it("rejects a TaskId value passed as BotId", () => {
    expect(() => Schema.decodeUnknownSync(BotId)(`task_${UUID}`)).toThrow()
  })

  it("newTaskId generates a value that TaskId decodes and BotId rejects", () => {
    const id = newTaskId()
    expect(Schema.decodeUnknownSync(TaskId)(id)).toBe(id)
    expect(() => Schema.decodeUnknownSync(BotId)(id)).toThrow()
  })
})
