import { describe, expect, it } from "vitest"
import {
  CHARS_PER_TOKEN,
  fitTokens,
  splitFenced,
  stripCode,
  summarizeText,
} from "../../src/context/compact-text.js"
import { fenced, fenceFor } from "../../src/context/fence.js"
import { estimateTokens } from "../../src/context/tokens.js"

describe("splitFenced", () => {
  it("splits a head and one fenced body, the shape fenced() writes", () => {
    const item = `- src/a.ts:1-3 (ts)\n${fenced("const a = 1\nconst b = 2")}`
    expect(splitFenced(item)).toEqual({ head: "- src/a.ts:1-3 (ts)", body: "const a = 1\nconst b = 2" })
  })

  it("does not split a text whose fence is in the middle of it", () => {
    const item = `# Rules\n${fenced("npm test")}\nthen read the docs`
    expect(splitFenced(item)).toBeUndefined()
  })

  it("does not split a text without a fence", () => {
    expect(splitFenced("- (fact, bot-dev) the parser keeps state")).toBeUndefined()
  })
})

describe("stripCode (level 1)", () => {
  it("drops comments, blank lines and imports and keeps the code", () => {
    const body = [
      "import { compute } from './compute.js'",
      "",
      "// explain the step",
      "# python style note",
      "const value = compute(input)",
      "/* block comment */",
      " * middle line of a block comment",
      " */",
      "return value",
    ].join("\n")
    expect(stripCode(body)).toBe("const value = compute(input)\nreturn value")
  })

  it("keeps a pointer dereference that starts with an asterisk", () => {
    expect(stripCode("*ptr = 3\n*p")).toBe("*ptr = 3\n*p")
  })

  it("drops a multi-line import up to its from line and keeps the code after it", () => {
    const body = ["import {", "  alpha,", "  beta", "} from './lib.js'", "const x = alpha"].join("\n")
    expect(stripCode(body)).toBe("const x = alpha")
  })

  it("keeps the code after a side-effect import, which is one line", () => {
    expect(stripCode("import './style.css'\nrun()")).toBe("run()")
  })

  it("keeps the lines of an import that never reaches its from, past the limit", () => {
    const body = ["import {", ...Array.from({ length: 60 }, () => "  name,")].join("\n")
    const out = stripCode(body)
    expect(out).toContain("  name,")
    expect(out.split("\n")).toHaveLength(61)
  })
})

describe("fitTokens and summarizeText", () => {
  it("cuts a text to the tokens the counter gives it, or empties it", () => {
    const text = "word ".repeat(2000)
    const out = fitTokens(text, 50, estimateTokens)
    expect(out.length).toBeGreaterThan(0)
    expect(estimateTokens(out)).toBeLessThanOrEqual(50)
    expect(fitTokens(text, 0, estimateTokens)).toBe("")
  })

  it("keeps the first line and the signature lines before the other lines, and marks the gap", () => {
    const text = [
      "first line of the excerpt",
      "filler filler filler filler filler filler filler",
      "export function run(input: string): Result",
      "filler filler filler filler filler filler filler",
      'throw new Error("boom")',
    ].join("\n")
    const summary = summarizeText(text, 20)
    expect(summary).toContain("first line of the excerpt")
    expect(summary).toContain("export function run")
    expect(summary).not.toContain("filler")
    expect(summary.length).toBeLessThanOrEqual(20 * CHARS_PER_TOKEN)
  })

  it("returns the text as it is when it already fits", () => {
    expect(summarizeText("short", 10)).toBe("short")
  })
})

// Hostile input (R14, 200 KB): every function here scans the text once, so each finishes at once. No wall-clock assertion.
describe("hostile input of 200 KB", () => {
  it("strips a text made of comment lines to nothing", () => {
    const hostile = `// ${"x".repeat(50)}\n`.repeat(4000)
    expect(hostile.length).toBeGreaterThan(200_000)
    expect(stripCode(hostile)).toBe("")
  })

  it("summarizes a text of repeated lines within its room", () => {
    const hostile = "const a = b\n".repeat(20_000)
    expect(summarizeText(hostile, 50).length).toBeLessThanOrEqual(50 * CHARS_PER_TOKEN)
  })

  it("splits or refuses a fence run without backtracking", () => {
    expect(splitFenced("`".repeat(200_000))).toBeUndefined()
    expect(
      splitFenced(`${"`".repeat(3)}\n${"a\n".repeat(100_000)}${"`".repeat(3)}`)?.body.length,
    ).toBeGreaterThan(0)
    expect(splitFenced(`${"\n".repeat(200_000)}\`\`\``)).toBeUndefined()
  })

  it("picks the fence of 400 KB of separated backticks without overflowing the stack", () => {
    const hostile = "`a".repeat(200_000)
    expect(hostile.length).toBeGreaterThanOrEqual(400_000)
    expect(fenceFor(hostile)).toBe("```")
    expect(fenceFor(`a${"`".repeat(5)}`)).toBe("``````")
  })
})
