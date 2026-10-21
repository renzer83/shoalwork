import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ContextAssembledPayload } from "../src/events/ops.js"

const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const BASE = { taskId: TASK, level: "full", used: 1200, budget: 6000, dropped: [{ block: "code", items: 2 }] }

const decode = Schema.decodeUnknownSync(ContextAssembledPayload)

describe("context.assembled tokenSource (T-095)", () => {
  it("is optional: a payload written before it existed still decodes", () => {
    expect(decode(BASE)).toEqual(BASE)
  })

  it("accepts approx and mixed, and round-trips them", () => {
    for (const tokenSource of ["approx", "mixed"] as const) {
      const payload = { ...BASE, tokenSource }
      expect(decode(payload)).toEqual(payload)
      expect(Schema.encodeSync(ContextAssembledPayload)(decode(payload))).toEqual(payload)
    }
  })

  it("rejects a source outside approx and mixed (the API source is gone)", () => {
    expect(() => decode({ ...BASE, tokenSource: "api" })).toThrow()
  })
})
