import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ContextAssembledPayload } from "../src/events/ops.js"

const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const BASE = { taskId: TASK, level: "full", used: 1200, budget: 6000, dropped: [] }
const ENTRY = { block: "code", level: 2, before: 900, after: 300 }

const decode = Schema.decodeUnknownSync(ContextAssembledPayload)
const encode = Schema.encodeSync(ContextAssembledPayload)

describe("context.assembled compaction (T-097)", () => {
  it("is optional: a payload written before it existed still decodes unchanged", () => {
    expect(decode(BASE)).toEqual(BASE)
  })

  it("round-trips a list of shortened blocks with their level and token counts", () => {
    const payload = { ...BASE, compaction: [ENTRY, { block: "memory", level: 3, before: 400, after: 60 }] }
    expect(decode(payload)).toEqual(payload)
    expect(encode(decode(payload))).toEqual(payload)
  })

  it("rejects a level outside 1 to 3 (level 0 is not a compaction)", () => {
    expect(() => decode({ ...BASE, compaction: [{ ...ENTRY, level: 0 }] })).toThrow()
    expect(() => decode({ ...BASE, compaction: [{ ...ENTRY, level: 4 }] })).toThrow()
  })

  it("rejects negative token counts and a missing block name", () => {
    expect(() => decode({ ...BASE, compaction: [{ ...ENTRY, before: -1 }] })).toThrow()
    expect(() => decode({ ...BASE, compaction: [{ ...ENTRY, block: undefined }] })).toThrow()
  })
})
