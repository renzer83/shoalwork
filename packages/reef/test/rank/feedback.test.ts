import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  MAX_DRIFT,
  MIN_TUNE_SAMPLES,
  objective,
  rankTune,
  recordOutcome,
  snapToGrid,
  type TuneSample,
  tuneWeights,
} from "../../src/rank/feedback.js"
import { Ranker, saveWeights } from "../../src/rank/ranker.js"
import { DEFAULT_WEIGHTS, RankWeights, SIGNALS, type SignalValues } from "../../src/rank/signals.js"
import { rankerEnv } from "./support.js"

const REPO = "github.com/acme/app"

const signals = (values: Partial<SignalValues>): SignalValues => ({
  bm25: 0,
  cosine: 0,
  recency: 0,
  imports: 0,
  success: 0,
  proximity: 0,
  ...values,
})

const successOf = (chunkId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly ok: number
      readonly fail: number
    }>`SELECT ok, fail FROM chunk_success WHERE repo = ${REPO} AND chunk_id = ${chunkId}`
    return rows[0]
  })

describe("recordOutcome", () => {
  it.effect("counts 3 ok tasks and 1 failed task against the chunks they used", () =>
    Effect.gen(function* () {
      yield* recordOutcome(REPO, ["c1", "c2"], true)
      yield* recordOutcome(REPO, ["c1"], true)
      yield* recordOutcome(REPO, ["c1", "c3", "c3"], true)
      yield* recordOutcome(REPO, ["c1", "c2"], false)
      expect(yield* successOf("c1")).toEqual({ ok: 3, fail: 1 })
      expect(yield* successOf("c2")).toEqual({ ok: 1, fail: 1 })
      // a chunk listed twice in one briefing counts once
      expect(yield* successOf("c3")).toEqual({ ok: 1, fail: 0 })
      expect(yield* successOf("c4")).toBeUndefined()
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("feeds the success signal of the next ranking", () =>
    Effect.gen(function* () {
      yield* recordOutcome(REPO, ["good"], true)
      yield* recordOutcome(REPO, ["good"], true)
      yield* recordOutcome(REPO, ["bad"], false)
      const ranked = yield* (yield* Ranker).rank(
        [
          { id: "bad", kind: "chunk", path: "a.ts", text: "", raw: {} },
          { id: "good", kind: "chunk", path: "b.ts", text: "", raw: {} },
        ],
        { repo: REPO, activeFiles: [], query: "q" },
      )
      expect(ranked.map((entry) => entry.id)).toEqual(["good", "bad"])
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("ignores an empty list", () =>
    Effect.gen(function* () {
      yield* recordOutcome(REPO, [], true)
      const sql = yield* SqlClient
      expect(yield* sql`SELECT * FROM chunk_success`).toEqual([])
    }).pipe(Effect.provide(rankerEnv())),
  )
})

// Tasks that went ok used chunks with strong import links; tasks that failed used chunks with strong text matches.
// Under the defaults the text-match chunks outrank the import chunks, so every briefing carried them.
const fixture = (): ReadonlyArray<TuneSample> =>
  Array.from({ length: 12 }, (_, i): TuneSample => {
    const ok = i % 2 === 0
    return {
      ok,
      candidates: [
        { id: `t${i}-text`, used: !ok, signals: signals({ bm25: 1, cosine: 0.9 }) },
        { id: `t${i}-link`, used: ok, signals: signals({ imports: 1, proximity: 0.6, bm25: 0.3 }) },
        { id: `t${i}-noise`, used: false, signals: signals({ recency: 0.2 }) },
      ],
    }
  })

describe("tuneWeights", () => {
  it("moves weight in steps of 0.05 and keeps the sum at 1", () => {
    const result = tuneWeights(fixture(), DEFAULT_WEIGHTS)
    expect(SIGNALS.reduce((sum, signal) => sum + result.weights[signal], 0)).toBeCloseTo(1)
    for (const signal of SIGNALS) {
      const steps = Math.abs(result.weights[signal] - DEFAULT_WEIGHTS[signal]) / 0.05
      expect(steps).toBeCloseTo(Math.round(steps))
      expect(result.weights[signal]).toBeGreaterThanOrEqual(0)
    }
  })

  it("chooses weights that raise the objective on the recorded tasks", () => {
    const samples = fixture()
    const result = tuneWeights(samples, DEFAULT_WEIGHTS)
    expect(result.after).toBeGreaterThan(result.before)
    expect(result.after).toBeCloseTo(objective(samples, result.weights))
    expect(result.before).toBeCloseTo(objective(samples, DEFAULT_WEIGHTS))
    expect(result.weights.imports).toBeGreaterThan(DEFAULT_WEIGHTS.imports)
    expect(result.weights.bm25 + result.weights.cosine).toBeLessThan(
      DEFAULT_WEIGHTS.bm25 + DEFAULT_WEIGHTS.cosine,
    )
  })

  it("never strays more than MAX_DRIFT from the starting weights", () => {
    const all: ReadonlyArray<TuneSample> = fixture().map((sample) => ({ ...sample, ok: true }))
    const result = tuneWeights(all, DEFAULT_WEIGHTS)
    for (const signal of SIGNALS) {
      expect(Math.abs(result.weights[signal] - DEFAULT_WEIGHTS[signal])).toBeLessThanOrEqual(MAX_DRIFT + 1e-9)
    }
  })

  it("keeps the weights when there is nothing to learn from, and is deterministic", () => {
    expect(tuneWeights([], DEFAULT_WEIGHTS).weights).toEqual(DEFAULT_WEIGHTS)
    const noneUsed: ReadonlyArray<TuneSample> = fixture().map((sample) => ({
      ok: sample.ok,
      candidates: sample.candidates.map((candidate) => ({ ...candidate, used: false })),
    }))
    expect(tuneWeights(noneUsed, DEFAULT_WEIGHTS).weights).toEqual(DEFAULT_WEIGHTS)
    expect(tuneWeights(fixture(), DEFAULT_WEIGHTS)).toEqual(tuneWeights(fixture(), DEFAULT_WEIGHTS))
  })
})

describe("rankTune", () => {
  it.effect("stores the tuned weights and reports the change", () =>
    Effect.gen(function* () {
      const report = yield* rankTune(fixture(), DEFAULT_WEIGHTS)
      expect(report.changed).toBe(true)
      expect(report.samples).toBe(12)
      expect(report.objectiveAfter).toBeGreaterThan(report.objectiveBefore)
      expect(yield* (yield* Ranker).weights()).toEqual(report.weights)
      // a second run starts from what was stored
      const again = yield* rankTune(fixture(), DEFAULT_WEIGHTS)
      expect(again.before).toEqual(report.weights)
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("changes nothing with fewer than the minimum samples", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const report = yield* rankTune(fixture().slice(0, MIN_TUNE_SAMPLES - 1), DEFAULT_WEIGHTS)
      expect(report.changed).toBe(false)
      expect(report.weights).toEqual(DEFAULT_WEIGHTS)
      expect(yield* sql`SELECT * FROM rank_weights`).toEqual([])
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("starts from the stored weights when there are some", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const stored = { ...DEFAULT_WEIGHTS, bm25: 0.2, imports: 0.2 }
      yield* saveWeights(sql, stored)
      const report = yield* rankTune(fixture(), DEFAULT_WEIGHTS)
      expect(report.before).toEqual(stored)
    }).pipe(Effect.provide(rankerEnv())),
  )
})

const THREE_DECIMALS = {
  bm25: 0.255,
  cosine: 0.245,
  recency: 0.1,
  imports: 0.15,
  success: 0.15,
  proximity: 0.1,
}
const sumOf = (weights: Record<string, number>) => Object.values(weights).reduce((sum, w) => sum + w, 0)

describe("weights with three decimals", () => {
  it("are put on the 0.05 grid with the sum kept at 1", () => {
    const snapped = snapToGrid(THREE_DECIMALS)
    expect(sumOf(snapped)).toBeCloseTo(1, 9)
    for (const signal of SIGNALS) {
      const steps = snapped[signal] / 0.05
      expect(steps).toBeCloseTo(Math.round(steps), 9)
    }
    expect(snapToGrid(DEFAULT_WEIGHTS)).toEqual(DEFAULT_WEIGHTS)
  })

  it("stay valid for any starting set that adds up to 1", () => {
    let seed = 7
    const next = () => {
      seed = (seed * 48271) % 2147483647
      return seed / 2147483647
    }
    for (let round = 0; round < 200; round++) {
      const raw = SIGNALS.map(() => next())
      const total = raw.reduce((sum, v) => sum + v, 0)
      const share = (index: number) => Math.round(((raw[index] ?? 0) / total) * 1000) / 1000
      const snapped = snapToGrid({
        bm25: share(0),
        cosine: share(1),
        recency: share(2),
        imports: share(3),
        success: share(4),
        proximity: share(5),
      })
      expect(Math.abs(sumOf(snapped) - 1)).toBeLessThan(1e-9)
      expect(Math.min(...Object.values(snapped))).toBeGreaterThanOrEqual(0)
    }
  })

  it("tune to weights that still add up to 1", () => {
    const result = tuneWeights(fixture(), THREE_DECIMALS)
    expect(Math.abs(sumOf(result.weights) - 1)).toBeLessThan(1e-9)
    expect(Schema.is(RankWeights)(result.weights)).toBe(true)
  })

  it("come back unchanged when no move helps", () => {
    expect(tuneWeights([], THREE_DECIMALS).weights).toEqual(THREE_DECIMALS)
  })

  it.effect("are stored by rankTune in a form the ranker can read back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES ('default', ${JSON.stringify(THREE_DECIMALS)}, '2026-10-21T00:00:00.000Z')`
      const report = yield* rankTune(fixture(), DEFAULT_WEIGHTS)
      expect(report.changed).toBe(true)
      const read = yield* (yield* Ranker).weights()
      expect(read).toEqual(report.weights)
      expect(Math.abs(sumOf(read) - 1)).toBeLessThan(1e-9)
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("saveWeights refuses weights that do not add up to 1 and writes nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const error = yield* Effect.flip(saveWeights(sql, { ...DEFAULT_WEIGHTS, bm25: 0.26 }))
      expect(error).toMatchObject({ _tag: "ConfigError", key: "rank_weights.save" })
      expect(yield* sql`SELECT * FROM rank_weights`).toEqual([])
    }).pipe(Effect.provide(rankerEnv())),
  )
})
