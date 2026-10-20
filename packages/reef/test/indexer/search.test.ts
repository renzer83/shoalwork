import { it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { describe, expect } from "vitest"
import { EmbedderTest } from "../../src/embedder.js"
import { Indexer, IndexerLive } from "../../src/indexer/indexer.js"
import {
  ftsMatchExpression,
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  matchesSymbol,
  queryTokens,
  reciprocalRankFusion,
  SYMBOL_BOOST,
} from "../../src/indexer/search.js"
import { failingEmbedder, indexerEnv, withFixtureRepo } from "./helpers.js"

describe("search helpers", () => {
  it("tokenizes queries and quotes every token for FTS5", () => {
    expect(queryTokens('where is parse_config? (NEAR) "x"')).toEqual([
      "where",
      "is",
      "parse_config",
      "NEAR",
      "x",
    ])
    expect(ftsMatchExpression("a-b OR c*")).toBe('"a" OR "b" OR "OR" OR "c"')
    expect(ftsMatchExpression("!!! ___")).toBe("")
  })

  it("fuses rankings with reciprocal rank fusion", () => {
    const scores = reciprocalRankFusion([
      ["a", "b"],
      ["b", "c"],
    ])
    expect(scores.get("a")).toBeCloseTo(1 / 61)
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61)
    expect(scores.get("c")).toBeCloseTo(1 / 62)
  })

  it("matches the query against symbols as whole, case-insensitive identifiers", () => {
    expect(matchesSymbol("show me ALPHA please", ["alpha"])).toBe(true)
    expect(matchesSymbol("alphabet", ["alpha"])).toBe(false)
    expect(matchesSymbol("alpha", [])).toBe(false)
  })
})

describe("Indexer.search", () => {
  it.effect("finds the chunk that defines a function by name and marks it as boosted", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        const hits = yield* indexer.search(id, "compute")
        const [top] = hits
        expect(top?.path).toBe("src/lib.rs")
        expect(top?.symbols).toEqual(["compute"])
        expect(top?.boosted).toBe(true)
        expect(top?.startLine).toBe(3)
        expect(top?.content).toContain("pub fn compute")
        expect(top?.score).toBeGreaterThan(SYMBOL_BOOST / (60 + 1) - 1e-9)
        expect(hits.filter((hit) => hit.boosted)).toHaveLength(1)
        const gamma = yield* indexer.search(id, "how does Gamma run")
        expect(gamma[0]?.path).toBe("src/app.ts")
        expect(gamma[0]?.symbols).toEqual(["Gamma"])
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("returns k hits by default 6, honours k and returns nothing for an empty query", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        expect(yield* indexer.search(id, "note line")).toHaveLength(6)
        expect(yield* indexer.search(id, "note line", 2)).toHaveLength(2)
        expect(yield* indexer.search(id, "   ")).toEqual([])
        expect(yield* indexer.search(id, "???")).toEqual([])
        expect(yield* indexer.search(id, "alpha", 0)).toEqual([])
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("only returns chunks of the requested repo", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir, { repo: "repo-a" })
        expect(yield* indexer.search("repo-b", "compute")).toEqual([])
        expect((yield* indexer.search("repo-a", "compute")).length).toBeGreaterThan(0)
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("still ranks lexically when the embedder is unavailable at query time", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        const offline = yield* Indexer.pipe(
          Effect.provide(IndexerLive().pipe(Layer.provide(failingEmbedder))),
        )
        const hits = yield* offline.search(id, "compute")
        expect(hits[0]?.path).toBe("src/lib.rs")
        expect(hits[0]?.boosted).toBe(true)
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("reports every file as failed (and indexes nothing) when the embedder is down", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.index(repo.dir)
        expect(report.failed).toHaveLength(5)
        expect(report.chunks).toBe(0)
      }),
    ).pipe(Effect.provide(indexerEnv(failingEmbedder))),
  )

  it.effect("survives hostile queries without FTS syntax errors", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        for (const query of [
          'foo" OR "bar',
          "NEAR(",
          "NEAR(a b, 2)",
          "*",
          '"',
          "a AND NOT",
          "path:src",
          "{content}: x",
          "compute ^ -",
          "x".repeat(100_000),
          "word ".repeat(5000),
        ]) {
          const hits = yield* indexer.search(id, query)
          expect(Array.isArray(hits)).toBe(true)
        }
        expect((yield* indexer.search(id, 'foo" OR "compute'))[0]?.path).toBe("src/lib.rs")
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("limits the semantic leg to maxSemanticChunks and warns once", () => {
    const messages: Array<string> = []
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(JSON.stringify(message))
    })
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir, { repo: "capped" })
        const first = yield* indexer.search(id, "compute")
        yield* indexer.search(id, "compute")
        expect(first[0]?.path).toBe("src/lib.rs")
        expect(messages.filter((message) => message.includes("limited to the 3 most recently"))).toHaveLength(
          1,
        )
      }),
    ).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provide(indexerEnv(EmbedderTest, { maxSemanticChunks: 3 })),
    )
  })

  it("bounds the number and size of query tokens", () => {
    expect(queryTokens("w ".repeat(100))).toHaveLength(MAX_QUERY_TOKENS)
    expect(queryTokens(`${"a".repeat(2000)} tail`)).toHaveLength(1)
    expect(queryTokens("a".repeat(2000))[0]).toHaveLength(MAX_QUERY_CHARS)
  })
})
