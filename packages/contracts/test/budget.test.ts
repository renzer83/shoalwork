import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { addUsage, Budget, exceeds, type Usage, usageToBudget, ZERO_USAGE } from "../src/budget.js"

const LIMIT = { tokens: 1000, seconds: 600, usd: 1.5 }

const usage = (overrides: Partial<Usage>): Usage => ({ ...ZERO_USAGE, ...overrides })

describe("budget", () => {
  it("Budget round-trips and rejects non-integer tokens", () => {
    const raw = { tokens: 10, seconds: 20, usd: 0.25 }
    expect(Schema.encodeSync(Budget)(Schema.decodeUnknownSync(Budget)(raw))).toEqual(raw)
    expect(() => Schema.decodeUnknownSync(Budget)({ tokens: 1.5, seconds: 20, usd: 0.25 })).toThrow()
  })

  it("Budget rejects negative, NaN and infinite limits", () => {
    const valid = { tokens: 0, seconds: 0, usd: 0 }
    expect(Schema.decodeUnknownSync(Budget)(valid)).toEqual(valid)
    for (const bad of [
      { tokens: -1, seconds: 20, usd: 0.25 },
      { tokens: 10, seconds: -1, usd: 0.25 },
      { tokens: 10, seconds: 20, usd: -0.01 },
      { tokens: 10, seconds: 20, usd: Number.NaN },
      { tokens: 10, seconds: 20, usd: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => Schema.decodeUnknownSync(Budget)(bad)).toThrow()
    }
  })

  it("addUsage sums every field", () => {
    const a = usage({ tokensIn: 1, tokensOut: 2, cacheRead: 3, cacheWrite: 4, usd: 0.5, seconds: 5 })
    const b = usage({ tokensIn: 10, tokensOut: 20, cacheRead: 30, cacheWrite: 40, usd: 0.25, seconds: 50 })
    expect(addUsage(a, b)).toEqual({
      tokensIn: 11,
      tokensOut: 22,
      cacheRead: 33,
      cacheWrite: 44,
      usd: 0.75,
      seconds: 55,
    })
    expect(addUsage(a, ZERO_USAGE)).toEqual(a)
  })

  it("usageToBudget counts tokens as tokensIn + tokensOut", () => {
    expect(usageToBudget(usage({ tokensIn: 7, tokensOut: 3, seconds: 9, usd: 0.1 }))).toEqual({
      tokens: 10,
      seconds: 9,
      usd: 0.1,
    })
  })

  it("exceeds reports nothing when used is within limit", () => {
    expect(exceeds({ tokens: 100, seconds: 60, usd: 0.1 }, LIMIT)).toEqual({ exceeded: false, by: [] })
  })

  it("exceeds reports only usd when only usd is above limit", () => {
    expect(exceeds({ tokens: 100, seconds: 60, usd: 2 }, LIMIT)).toEqual({ exceeded: true, by: ["usd"] })
  })

  it("exceeds reports every dimension when all are above limit", () => {
    expect(exceeds({ tokens: 2000, seconds: 900, usd: 3 }, LIMIT)).toEqual({
      exceeded: true,
      by: ["tokens", "seconds", "usd"],
    })
  })
})
