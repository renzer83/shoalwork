import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EventPayloads } from "../src/events/index.js"

const BASE = {
  taskId: "task_00000000-0000-4000-8000-000000000001",
  botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  executor: "claude-code",
  model: "claude-haiku-5-5",
  cwd: "/work/tree",
}
const decode = Schema.decodeUnknownSync(EventPayloads["executor.started"])

describe("executor.started payload (T-057)", () => {
  it("round-trips the permission mode and the tool list", () => {
    const payload = { ...BASE, permissionMode: "auto", allowedTools: ["Read", "Bash(pnpm test *)"] }
    expect(decode(payload)).toEqual(payload)
  })

  it("still decodes events written before the fields existed", () => {
    expect(decode(BASE)).toEqual(BASE)
  })

  it("rejects a permission mode outside the contract", () => {
    expect(() => decode({ ...BASE, permissionMode: "yolo", allowedTools: [] })).toThrow()
  })
})
