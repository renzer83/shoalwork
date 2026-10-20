import { describe, expect, it } from "vitest"
import { criterionRule } from "../src/rules.js"

describe("criterionRule (noul: result meets criterion?, rule v0)", () => {
  it("pass is a confident yes", () => {
    expect(criterionRule("pass")).toEqual({ value: true, confidence: 0.9 })
  })

  it("fail is a confident no", () => {
    expect(criterionRule("fail")).toEqual({ value: false, confidence: 0.9 })
  })

  it("none is a guess at 0.5", () => {
    expect(criterionRule("none")).toEqual({ value: false, confidence: 0.5 })
  })
})
