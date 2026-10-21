import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { type Candidate, Ranker, RankerLive, RankerTest, saveWeights } from "../../src/rank/ranker.js"
import { DEFAULT_WEIGHTS, recencySignal, SIGNALS } from "../../src/rank/signals.js"
import { chunk, insertChunk, only, rankerEnv } from "./support.js"

const REPO = "github.com/acme/app"
const ctxOf = (activeFiles: ReadonlyArray<string> = []) => ({ repo: REPO, activeFiles, query: "q" })

const idsOf = (ranked: ReadonlyArray<{ readonly id: string }>) => ranked.map((entry) => entry.id)

describe("each signal alone orders a fixture of six candidates", () => {
  it.effect("bm25: higher text score first", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const scores = [3.1, 12.5, 0.4, 8, 7.9, 1]
      const cands = scores.map((bm25, i) => chunk(`c${i}`, `src/f${i}.ts`, { bm25 }))
      expect(idsOf(yield* ranker.rank(cands, ctxOf()))).toEqual(["c1", "c3", "c4", "c0", "c5", "c2"])
    }).pipe(Effect.provide(rankerEnv(only("bm25")))),
  )

  it.effect("cosine: closer vector first; the farthest one and a candidate without a vector tie at 0", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const cands = [
        chunk("c0", "a.ts", { cosine: 0.31 }),
        chunk("c1", "b.ts", { cosine: 0.92 }),
        chunk("c2", "c.ts"),
        chunk("c3", "d.ts", { cosine: 0.55 }),
        chunk("c4", "e.ts", { cosine: 0.7 }),
        chunk("c5", "f.ts", { cosine: 0.12 }),
      ]
      expect(idsOf(yield* ranker.rank(cands, ctxOf()))).toEqual(["c1", "c4", "c3", "c0", "c2", "c5"])
    }).pipe(Effect.provide(rankerEnv(only("cosine")))),
  )

  it.effect("recency: the most recently committed file first", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const ages = [90, 0, 365, 10, 30, 3]
      const cands = ages.map((age, i) => chunk(`c${i}`, `src/f${i}.ts`, { recency: recencySignal(age) }))
      expect(idsOf(yield* ranker.rank(cands, ctxOf()))).toEqual(["c1", "c5", "c3", "c4", "c0", "c2"])
    }).pipe(Effect.provide(rankerEnv(only("recency")))),
  )

  it.effect("imports: 1 for a direct import either way, 0.5 two hops away, 0 otherwise", () =>
    Effect.gen(function* () {
      const files: ReadonlyArray<readonly [string, string, string]> = [
        ["chk_a", "src/a.ts", 'import { b } from "./b.js"\n'],
        ["chk_b", "src/b.ts", 'import { c } from "./c"\n'],
        ["chk_c", "src/c.ts", "export const c = 1\n"],
        ["chk_d", "src/d.ts", 'import { a } from "./a"\n'],
        ["chk_e", "src/e.ts", "export const e = 1\n"],
        ["chk_f", "src/f.ts", 'import { e } from "./e"\n'],
      ]
      for (const [id, path, content] of files) yield* insertChunk(REPO, id, path, content)
      const ranker = yield* Ranker
      const cands = files.slice(1).map(([id, path]) => chunk(id, path))
      const ranked = yield* ranker.rank(cands, ctxOf(["src/a.ts"]))
      expect(idsOf(ranked)).toEqual(["chk_b", "chk_d", "chk_c", "chk_e", "chk_f"])
      expect(ranked.map((entry) => entry.signals.imports)).toEqual([1, 1, 0.5, 0, 0])
    }).pipe(Effect.provide(rankerEnv(only("imports")))),
  )

  it.effect("success: ok / (ok + fail + 1) from chunk_success", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const history: ReadonlyArray<readonly [string, number, number]> = [
        ["s1", 9, 0],
        ["s2", 6, 1],
        ["s3", 0, 3],
        ["s5", 1, 0],
      ]
      for (const [id, ok, fail] of history) {
        yield* sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES (${REPO}, ${id}, ${ok}, ${fail})`
      }
      // the same chunk id under another repo does not count
      yield* sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES ('other', 's4', 50, 0)`
      const ranker = yield* Ranker
      const ids = ["s1", "s2", "s3", "s4", "s5", "s6"]
      const ranked = yield* ranker.rank(
        ids.map((id) => chunk(id, `src/${id}.ts`)),
        ctxOf(),
      )
      expect(idsOf(ranked)).toEqual(["s1", "s2", "s5", "s3", "s4", "s6"])
    }).pipe(Effect.provide(rankerEnv(only("success")))),
  )

  it.effect("proximity: same file, same directory, same package, then the rest", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const paths = ["lib/z.ts", "src/core/a.ts", "src/other/c.ts", "src/core/b.ts", "docs/x.ts", "lib/y.ts"]
      const ranked = yield* ranker.rank(
        paths.map((path, i) => chunk(`p${i}`, path)),
        ctxOf(["./src/core/a.ts"]),
      )
      expect(idsOf(ranked)).toEqual(["p1", "p3", "p2", "p0", "p4", "p5"])
    }).pipe(Effect.provide(rankerEnv(only("proximity")))),
  )
})

const BIASED = { ...DEFAULT_WEIGHTS, bm25: 0.1, cosine: 0.4 }

describe("combination", () => {
  it.effect("adds weight times normalized signal and reports each contribution", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const [top, second] = yield* ranker.rank(
        [
          chunk("a", "src/a.ts", { bm25: 10, cosine: 0.2, recency: 0.5 }),
          chunk("b", "src/b.ts", { bm25: 5, cosine: 0.8, recency: 0.5 }),
        ],
        ctxOf(),
      )
      // a: bm25 1, cosine 0, recency 1 (no range, positive). b: bm25 0, cosine 1, recency 1.
      expect(top?.id).toBe("b")
      expect(top?.score).toBeCloseTo(BIASED.cosine + BIASED.recency)
      expect(second?.score).toBeCloseTo(BIASED.bm25 + BIASED.recency)
      const total = SIGNALS.reduce((sum, signal) => sum + (top?.contrib[signal] ?? 0), 0)
      expect(total).toBeCloseTo(top?.score ?? -1)
    }).pipe(Effect.provide(rankerEnv(BIASED))),
  )

  it.effect("ranks memories on the signals they bring", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const memory = (id: string, raw: Candidate["raw"]): Candidate => ({ id, kind: "memory", text: id, raw })
      const ranked = yield* ranker.rank(
        [memory("m1", { bm25: 1, cosine: 0.1 }), memory("m2", { bm25: 4, cosine: 0.9 }), memory("m3", {})],
        ctxOf(["src/a.ts"]),
      )
      expect(idsOf(ranked)).toEqual(["m2", "m1", "m3"])
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("returns the same order for the same batch in any input order", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const cands = ["t1", "t2", "t3", "t4", "t5"].map((id) =>
        chunk(id, `src/${id}.ts`, { bm25: 2, cosine: 0.5 }),
      )
      const first = idsOf(yield* ranker.rank(cands, ctxOf(["src/t3.ts"])))
      const again = idsOf(yield* ranker.rank(cands, ctxOf(["src/t3.ts"])))
      const reversed = idsOf(yield* ranker.rank([...cands].reverse(), ctxOf(["src/t3.ts"])))
      expect(again).toEqual(first)
      expect(reversed).toEqual(first)
      expect(first[0]).toBe("t3")
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("ranks an empty batch to an empty list", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Ranker).rank([], ctxOf())).toEqual([])
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("RankerTest ranks on raw signals with fixed weights", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      const ranked = yield* ranker.rank(
        [chunk("a", "a.ts", { bm25: 1 }), chunk("b", "b.ts", { bm25: 2 })],
        ctxOf(),
      )
      expect(idsOf(ranked)).toEqual(["b", "a"])
      expect(yield* ranker.weights()).toEqual(only("bm25"))
    }).pipe(Effect.provide(RankerTest(only("bm25")))),
  )
})

describe("weights", () => {
  const swayed: ReadonlyArray<Candidate> = [
    chunk("text", "a.ts", { bm25: 10, cosine: 0.1 }),
    chunk("vector", "b.ts", { bm25: 1, cosine: 0.9 }),
  ]

  it.effect("come from the config when nothing is stored", () =>
    Effect.gen(function* () {
      const ranker = yield* Ranker
      expect(yield* ranker.weights()).toEqual(only("bm25"))
      expect(idsOf(yield* ranker.rank(swayed, ctxOf()))).toEqual(["text", "vector"])
    }).pipe(Effect.provide(rankerEnv(only("bm25")))),
  )

  it.effect("stored in the database win over the config", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* saveWeights(sql, only("cosine"))
      const ranker = yield* Ranker
      expect(yield* ranker.weights()).toEqual(only("cosine"))
      expect(idsOf(yield* ranker.rank(swayed, ctxOf()))).toEqual(["vector", "text"])
    }).pipe(Effect.provide(rankerEnv(only("bm25")))),
  )

  it.effect("stored weights that do not add up to 1 are a ConfigError", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const broken = JSON.stringify({ ...DEFAULT_WEIGHTS, bm25: 0.9 })
      yield* sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES ('default', ${broken}, '2026-10-21T00:00:00.000Z')`
      const ranker = yield* Ranker
      const error = yield* Effect.flip(ranker.rank(swayed, ctxOf()))
      expect(error._tag).toBe("ConfigError")
      expect(yield* Effect.flip(ranker.weights())).toMatchObject({
        _tag: "ConfigError",
        key: "rank_weights.default",
      })
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("stored weights that are not JSON are a ConfigError", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES ('default', 'nope', '2026-10-21T00:00:00.000Z')`
      const error = yield* Effect.flip((yield* Ranker).weights())
      expect(error._tag).toBe("ConfigError")
    }).pipe(Effect.provide(rankerEnv())),
  )

  it.effect("configured weights that do not add up to 1 refuse to build the ranker", () =>
    Effect.gen(function* () {
      const layer = RankerLive({ weights: { ...DEFAULT_WEIGHTS, imports: 0.5 } }).pipe(
        Layer.provide(withTempDb()),
      )
      const error = yield* Effect.flip(Effect.scoped(Layer.build(layer)))
      expect(error).toMatchObject({ _tag: "ConfigError", key: "rank.weights" })
    }),
  )
})
