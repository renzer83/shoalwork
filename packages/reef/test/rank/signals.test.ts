import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ageDaysOf,
  DEFAULT_WEIGHTS,
  importsSignal,
  minMax,
  packageRootOf,
  proximitySignal,
  RankWeights,
  recencySignal,
  SIGNALS,
  successSignal,
} from "../../src/rank/signals.js"

describe("normalization", () => {
  it("scales a batch to [0, 1] by min-max and treats absent values as 0", () => {
    expect(minMax([2, 4, undefined, 6])).toEqual([0, 0.5, 0, 1])
  })

  it("gives 1 to a positive value when the batch has no range, and 0 to the rest", () => {
    expect(minMax([3, 3, undefined])).toEqual([1, 1, 0])
    expect(minMax([0, 0])).toEqual([0, 0])
    expect(minMax([Number.NaN, 5])).toEqual([0, 1])
  })
})

describe("signal formulas", () => {
  it("decays recency with exp(-days / 30)", () => {
    expect(recencySignal(0)).toBe(1)
    expect(recencySignal(30)).toBeCloseTo(Math.exp(-1))
    expect(recencySignal(-4)).toBe(1)
    expect(recencySignal(365)).toBeLessThan(recencySignal(90))
  })

  it("reads the age of a commit time and ignores a missing or broken one", () => {
    const now = Date.parse("2026-10-21T00:00:00Z")
    expect(ageDaysOf("2026-10-11T00:00:00Z", now)).toBeCloseTo(10)
    expect(ageDaysOf(null, now)).toBeUndefined()
    expect(ageDaysOf("not a date", now)).toBeUndefined()
  })

  it("computes success as ok / (ok + fail + 1)", () => {
    expect(successSignal(0, 0)).toBe(0)
    expect(successSignal(3, 0)).toBe(0.75)
    expect(successSignal(3, 1)).toBeCloseTo(0.6)
  })

  it("maps import distance to 1, 0.5 and 0", () => {
    expect([importsSignal(1), importsSignal(2), importsSignal(3), importsSignal(undefined)]).toEqual([
      1, 0.5, 0, 0,
    ])
  })

  it("scores proximity by file, directory and package", () => {
    const active = ["packages/reef/src/rank/ranker.ts"]
    expect(proximitySignal("packages/reef/src/rank/ranker.ts", active)).toBe(1)
    expect(proximitySignal("./packages/reef/src/rank/signals.ts", active)).toBe(0.6)
    expect(proximitySignal("packages/reef/test/rank/ranker.test.ts", active)).toBe(0.3)
    expect(proximitySignal("packages/lead/src/briefing.ts", active)).toBe(0)
    expect(proximitySignal("README", active)).toBe(0)
    expect(proximitySignal("a.ts", [])).toBe(0)
  })

  it("finds the package of a path", () => {
    expect(packageRootOf("packages/reef/src/a.ts")).toBe("packages/reef")
    expect(packageRootOf("src/deep/a.ts")).toBe("src")
    expect(packageRootOf("a.ts")).toBe("")
    expect(packageRootOf("packages/a.ts")).toBe("packages")
  })
})

describe("weights", () => {
  it("accepts the defaults, which add up to 1", () => {
    expect(SIGNALS.reduce((sum, signal) => sum + DEFAULT_WEIGHTS[signal], 0)).toBeCloseTo(1)
    expect(Schema.decodeUnknownSync(RankWeights)(DEFAULT_WEIGHTS)).toEqual(DEFAULT_WEIGHTS)
  })

  it("rejects weights that do not add up to 1, or are negative", () => {
    expect(() => Schema.decodeUnknownSync(RankWeights)({ ...DEFAULT_WEIGHTS, bm25: 0.5 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RankWeights)({ ...DEFAULT_WEIGHTS, bm25: -0.25, cosine: 0.75 }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(RankWeights)({ bm25: 1 })).toThrow()
  })
})
