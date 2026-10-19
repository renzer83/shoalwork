import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Verdict } from "../src/verdict.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const withEvidence = (evidence: ReadonlyArray<string>) => ({
  ...(fixture("verdict.json") as object),
  evidence,
})

describe("verdict", () => {
  it("Verdict round-trips the fixture", () => {
    const raw = fixture("verdict.json")
    expect(Schema.encodeSync(Verdict)(Schema.decodeUnknownSync(Verdict)(raw))).toEqual(raw)
  })

  it("accepts evidence with a string of exactly 500 characters", () => {
    const raw = withEvidence(["x".repeat(500)])
    expect(Schema.decodeUnknownSync(Verdict)(raw).evidence[0]?.length).toBe(500)
  })

  it("rejects evidence with a string longer than 500 characters", () => {
    expect(() => Schema.decodeUnknownSync(Verdict)(withEvidence(["x".repeat(501)]))).toThrow()
  })

  it("rejects a verdict kind outside the closed list", () => {
    const raw = { ...(fixture("verdict.json") as object), kind: "maybe" }
    expect(() => Schema.decodeUnknownSync(Verdict)(raw)).toThrow()
  })

  it("accepts a verdict without sessionId", () => {
    const { sessionId: _sessionId, ...raw } = fixture("verdict.json") as { sessionId: string }
    expect(Schema.decodeUnknownSync(Verdict)(raw).sessionId).toBeUndefined()
  })
})
