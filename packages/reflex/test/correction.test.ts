import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  coerceCorrection,
  fitsKind,
  fitsQuestion,
  formatCorrection,
  parseCorrection,
  type Question,
  type Roster,
} from "../src/contract.js"

const ROSTER: Roster = { bots: [{ id: "bot_lead" }], executors: [{ id: "claude-code" }] }

describe("parseCorrection", () => {
  it("reads the value after the mark and ignores the spacing around it", () => {
    expect(parseCorrection("-> code")).toEqual(Option.some("code"))
    expect(parseCorrection("->code")).toEqual(Option.some("code"))
    expect(parseCorrection("->   research  ")).toEqual(Option.some("research"))
  })

  it("reads free text and an empty mark as no value", () => {
    expect(parseCorrection("devia ir para o writer")).toEqual(Option.none())
    expect(parseCorrection(" -> code")).toEqual(Option.none())
    expect(parseCorrection("->")).toEqual(Option.none())
    expect(parseCorrection("-> ")).toEqual(Option.none())
    expect(parseCorrection("")).toEqual(Option.none())
  })

  it("stays linear on a 200 KB hostile note", () => {
    const blanks = `->${" ".repeat(200_000)}`
    expect(parseCorrection(blanks)).toEqual(Option.none())

    const long = `-> ${"a".repeat(200_000)}`
    expect(parseCorrection(long)).toEqual(Option.some("a".repeat(200_000)))

    const noMark = "x".repeat(200_000)
    expect(parseCorrection(noMark)).toEqual(Option.none())
  })

  it("is the inverse of formatCorrection for every value kind", () => {
    for (const value of ["code", "true", "7"]) {
      expect(parseCorrection(formatCorrection(value))).toEqual(Option.some(value))
    }
  })
})

describe("coerceCorrection", () => {
  it("types the raw value by the kind of its question", () => {
    expect(coerceCorrection("true", "noul")).toBe(true)
    expect(coerceCorrection("false", "noul")).toBe(false)
    expect(coerceCorrection("3", "score")).toBe(3)
    expect(coerceCorrection("code", "choice")).toBe("code")
  })

  it("refuses a raw value that does not read as its kind", () => {
    expect(coerceCorrection("maybe", "noul")).toBeUndefined()
    expect(coerceCorrection("NaN", "score")).toBeUndefined()
    expect(coerceCorrection("", "choice")).toBeUndefined()
  })
})

describe("fitsQuestion", () => {
  const intent: Question = {
    id: "intent",
    kind: "choice",
    options: ["chat", "system", "code", "research", "app_op", "routine"],
  }
  const owner: Question = { id: "owner", kind: "choice", options: [] }
  const risk: Question = { id: "risk", kind: "score", scale: [0, 3] }

  it("accepts only the declared options of a static choice", () => {
    expect(fitsQuestion(intent, "research", ROSTER)).toBe(true)
    expect(fitsQuestion(intent, "writer", ROSTER)).toBe(false)
  })

  it("takes the owner and executor options from the roster", () => {
    expect(fitsQuestion(owner, "bot_lead", ROSTER)).toBe(true)
    expect(fitsQuestion(owner, "new", ROSTER)).toBe(true)
    expect(fitsQuestion(owner, "bot_other", ROSTER)).toBe(false)
  })

  it("keeps a score inside its scale", () => {
    expect(fitsQuestion(risk, 3, ROSTER)).toBe(true)
    expect(fitsQuestion(risk, 4, ROSTER)).toBe(false)
  })

  it("checks only the type for a question the contract does not declare", () => {
    expect(fitsKind("noul", true)).toBe(true)
    expect(fitsKind("noul", "yes")).toBe(false)
    expect(fitsKind("score", 9)).toBe(true)
    expect(fitsKind("choice", "anything")).toBe(true)
  })
})
