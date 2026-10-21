import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { McpServerChangedPayload } from "../src/events/mcp.js"

const decode = Schema.decodeUnknownSync(McpServerChangedPayload)
const encode = Schema.encodeSync(McpServerChangedPayload)

describe("mcp.server_changed for runs", () => {
  it("round-trips an attachment with its tools", () => {
    const payload = { action: "attached", server: "notes", taskId: "task_1", tools: ["read", "list"] }
    expect(encode(decode(payload))).toEqual(payload)
  })

  it("round-trips a refusal with its reason", () => {
    const payload = { action: "attach_refused", server: "notes", reason: "list_tools_failed" }
    expect(encode(decode(payload))).toEqual(payload)
  })

  it("rejects an unknown action or reason", () => {
    expect(() => decode({ action: "leaked", server: "notes" })).toThrow()
    expect(() => decode({ action: "attach_refused", server: "notes", reason: "because" })).toThrow()
  })
})
