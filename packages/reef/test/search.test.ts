import { it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Embedder, EmbedError, testVector } from "../src/embedder.js"
import { Reef } from "../src/reef.js"
import { fuse, RRF_K, toFtsQuery } from "../src/search.js"
import { atCosine, axis, fixtureEmbedder, reefStack } from "./support.js"

const BOT = { scope: "bot", ownerId: "bot_a" } as const

describe("toFtsQuery", () => {
  it("quotes every term so FTS5 operators become plain words", () => {
    expect(toFtsQuery("NEAR(foo bar) AND baz")).toBe('"near" OR "foo" OR "bar" OR "and" OR "baz"')
  })

  it("drops syntax characters and keeps unicode letters", () => {
    expect(toFtsQuery('-gato* "preto" content:coração')).toBe('"gato" OR "preto" OR "content" OR "coração"')
  })

  it("returns undefined when there is nothing searchable", () => {
    expect(toFtsQuery('*"^()-')).toBeUndefined()
    expect(toFtsQuery("   ")).toBeUndefined()
  })

  it("never produces a quote inside a term", () => {
    expect(toFtsQuery(`a"b"c`)).toBe('"a" OR "b" OR "c"')
  })
})

describe("fuse (RRF)", () => {
  it("sums 1/(60+rank) over the lists an id appears in", () => {
    const scores = fuse([
      ["a", "b"],
      ["b", "c"],
    ])
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1))
    expect(scores.get("b")).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
    expect(scores.get("c")).toBeCloseTo(1 / (RRF_K + 2))
  })
})

describe("hybrid search", () => {
  it.effect("ranks an item present in both lists above items present in only one", () => {
    const placed = {
      invoice: axis(1),
      "invoice from vendor": [...axis(1).map((x) => x * 0.9)].map((x, i) => (i === 2 ? 0.43589 : x)),
      "billing statement": axis(1),
    }
    return Effect.gen(function* () {
      const reef = yield* Reef
      const both = yield* reef.remember({
        ...BOT,
        kind: "semantic",
        content: "invoice from vendor",
        source: "t",
      })
      const semanticOnly = yield* reef.remember({
        ...BOT,
        kind: "semantic",
        content: "billing statement",
        source: "t",
      })
      const lexicalOnly = yield* reef.remember({
        ...BOT,
        kind: "semantic",
        content: "the invoice word shows up in a different story",
        source: "t",
      })
      const hits = yield* reef.search("invoice", { scopes: [BOT] })
      expect(hits.map((h) => h.id)[0]).toBe(both.id)
      expect(hits.map((h) => h.id).sort()).toEqual([both.id, semanticOnly.id, lexicalOnly.id].sort())
      const score = (id: string) => hits.find((h) => h.id === id)?.score ?? 0
      expect(score(both.id)).toBeGreaterThan(score(semanticOnly.id))
      expect(score(both.id)).toBeGreaterThan(score(lexicalOnly.id))
    }).pipe(Effect.provide(reefStack(fixtureEmbedder(placed))))
  })

  it.effect("survives hostile FTS5 input and leaves the table intact", () => {
    const hostile = [
      '"unterminated',
      "foo*",
      "NEAR(a b)",
      "NEAR/2 a b",
      "-secret",
      "a AND",
      "OR",
      "NOT x",
      "content:secret",
      "^start",
      ")(",
      "'; DROP TABLE memory_items; --",
      "*",
      '""',
    ]
    return Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      yield* reef.remember({ ...BOT, kind: "semantic", content: "secret plan for the garden", source: "t" })
      for (const q of hostile) {
        const hits = yield* reef.search(q, { scopes: [BOT] })
        expect(Array.isArray(hits)).toBe(true)
      }
      const rows = yield* sql`SELECT count(*) AS n FROM memory_items`
      expect(rows).toEqual([{ n: 1 }])
    }).pipe(Effect.provide(reefStack()))
  })

  it.effect("treats operators as literal words: minus is not negation and NEAR is a plain term", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const plan = yield* reef.remember({ ...BOT, kind: "semantic", content: "secret plan", source: "t" })
      const near = yield* reef.remember({
        ...BOT,
        kind: "semantic",
        content: "keep NEAR the door",
        source: "t",
      })
      expect((yield* reef.search("-secret", { scopes: [BOT] })).map((h) => h.id)).toEqual([plan.id])
      expect((yield* reef.search("near", { scopes: [BOT] })).map((h) => h.id)).toEqual([near.id])
      expect((yield* reef.search("secret*", { scopes: [BOT] })).map((h) => h.id)).toEqual([plan.id])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("returns nothing for an empty query, empty scopes, empty kinds or k = 0", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      yield* reef.remember({ ...BOT, kind: "semantic", content: "alpha beta", source: "t" })
      expect(yield* reef.search("   ", { scopes: [BOT] })).toEqual([])
      expect(yield* reef.search("alpha", { scopes: [] })).toEqual([])
      expect(yield* reef.search("alpha", { scopes: [BOT], kinds: [] })).toEqual([])
      expect(yield* reef.search("alpha", { scopes: [BOT], k: 0 })).toEqual([])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("honours k (default 8) and the kinds filter", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      for (let index = 0; index < 10; index++) {
        yield* reef.remember({
          ...BOT,
          kind: index < 3 ? "episodic" : "semantic",
          content: `deploy note ${index}`,
          source: "t",
        })
      }
      expect(yield* reef.search("deploy", { scopes: [BOT] })).toHaveLength(8)
      expect(yield* reef.search("deploy", { scopes: [BOT], k: 2 })).toHaveLength(2)
      const episodic = yield* reef.search("deploy", { scopes: [BOT], kinds: ["episodic"] })
      expect(episodic).toHaveLength(3)
      expect(episodic.every((h) => h.kind === "episodic")).toBe(true)
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("skips a malformed embedding instead of failing the search", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      yield* sql`INSERT INTO memory_items (id, scope, owner_id, kind, content, source, created_at, embedding)
        VALUES ('mem_bad', 'bot', 'bot_a', 'semantic', 'broken vector row', 't', '2026-10-20T00:00:00.000Z', ${new Uint8Array(5)})`
      const hits = yield* reef.search("broken", { scopes: [BOT] })
      expect(hits.map((h) => h.id)).toEqual(["mem_bad"])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect(
    "falls back to the lexical list when the query cannot be embedded, warning once without the query text",
    () => {
      const messages: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ message, logLevel }) => {
          messages.push(`${logLevel}:${JSON.stringify(message)}`)
        }),
      ])
      const failing = Layer.succeed(Embedder, {
        dims: 1024,
        embed: (texts: ReadonlyArray<string>) =>
          texts[0] === "needle topsecretquery"
            ? Effect.fail(new EmbedError({ reason: "transport", detail: "down" }))
            : Effect.succeed(texts.map(testVector)),
      })
      return Effect.gen(function* () {
        const reef = yield* Reef
        const item = yield* reef.remember({
          ...BOT,
          kind: "semantic",
          content: "needle in a haystack",
          source: "t",
        })
        const hits = yield* reef.search("needle topsecretquery", { scopes: [BOT] })
        expect(hits.map((h) => h.id)).toEqual([item.id])
        const warnings = messages.filter((m) => m.startsWith("Warn"))
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).not.toContain("topsecretquery")
      }).pipe(Effect.provide(reefStack(failing)), Effect.provide(capture))
    },
  )

  it.effect(
    "treats a query vector with the wrong dimension as an embedding failure and stays lexical",
    () => {
      const wrong = Layer.succeed(Embedder, {
        dims: 1024,
        embed: (texts: ReadonlyArray<string>) =>
          Effect.succeed(texts.map((text) => (text === "wrongdim" ? [1, 0, 0] : testVector(text)))),
      })
      return Effect.gen(function* () {
        const reef = yield* Reef
        const item = yield* reef.remember({
          ...BOT,
          kind: "semantic",
          content: "wrongdim marker",
          source: "t",
        })
        const hits = yield* reef.search("wrongdim", { scopes: [BOT] })
        expect(hits.map((h) => h.id)).toEqual([item.id])
      }).pipe(Effect.provide(reefStack(wrong)))
    },
  )
})

describe("semantic floor", () => {
  const placed = {
    zzz: axis(0),
    "close item": atCosine(0.3),
    "far item": atCosine(0.2),
  }
  const seed = Effect.gen(function* () {
    const reef = yield* Reef
    const close = yield* reef.remember({ ...BOT, kind: "semantic", content: "close item", source: "t" })
    const far = yield* reef.remember({ ...BOT, kind: "semantic", content: "far item", source: "t" })
    return { reef, close, far }
  })

  it.effect("default floor 0.25 excludes cosine 0.2 and includes cosine 0.3", () =>
    Effect.gen(function* () {
      const { reef, close } = yield* seed
      expect((yield* reef.search("zzz", { scopes: [BOT] })).map((h) => h.id)).toEqual([close.id])
    }).pipe(Effect.provide(reefStack(fixtureEmbedder(placed)))),
  )

  it.effect("a lower custom floor lets both in, a higher one lets none in", () =>
    Effect.gen(function* () {
      const { reef, close, far } = yield* seed
      expect((yield* reef.search("zzz", { scopes: [BOT] })).map((h) => h.id)).toEqual([close.id, far.id])
    }).pipe(Effect.provide(reefStack(fixtureEmbedder(placed), { semanticFloor: 0.1 }))),
  )

  it.effect("a floor above every cosine empties the semantic list", () =>
    Effect.gen(function* () {
      const { reef } = yield* seed
      expect(yield* reef.search("zzz", { scopes: [BOT] })).toEqual([])
    }).pipe(Effect.provide(reefStack(fixtureEmbedder(placed), { semanticFloor: 0.5 }))),
  )
})

describe("lexical ranking direction", () => {
  it.effect(
    "the shorter document with the same term count wins bm25 (k = 1), whatever the insertion order",
    () =>
      Effect.gen(function* () {
        const reef = yield* Reef
        yield* reef.remember({
          ...BOT,
          kind: "semantic",
          content: "apple pear peach plum banana grape melon cherry",
          source: "t",
        })
        const short = yield* reef.remember({ ...BOT, kind: "semantic", content: "banana", source: "t" })
        const hits = yield* reef.search("banana", { scopes: [BOT], k: 1 })
        expect(hits.map((h) => h.id)).toEqual([short.id])
      }).pipe(Effect.provide(reefStack())),
  )

  it.effect("repeating the term raises the rank at equal length", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      yield* reef.remember({ ...BOT, kind: "semantic", content: "banana kiwi lime lemon", source: "t" })
      const dense = yield* reef.remember({
        ...BOT,
        kind: "semantic",
        content: "banana banana banana lemon",
        source: "t",
      })
      const hits = yield* reef.search("banana", { scopes: [BOT], k: 1 })
      expect(hits.map((h) => h.id)).toEqual([dense.id])
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("malformed embeddings", () => {
  it.effect("are counted and warned once per search", () => {
    const messages: Array<string> = []
    const capture = Logger.layer([
      Logger.make(({ message, logLevel }) => {
        messages.push(`${logLevel}:${JSON.stringify(message)}`)
      }),
    ])
    return Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      for (const id of ["mem_bad1", "mem_bad2", "mem_bad3"]) {
        yield* sql`INSERT INTO memory_items (id, scope, owner_id, kind, content, source, created_at, embedding)
          VALUES (${id}, 'bot', 'bot_a', 'semantic', 'broken row', 't', '2026-10-20T00:00:00.000Z', ${new Uint8Array(5)})`
      }
      yield* reef.search("broken", { scopes: [BOT] })
      const warnings = messages.filter((m) => m.startsWith("Warn"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("3 memory embedding")
    }).pipe(Effect.provide(reefStack()), Effect.provide(capture))
  })
})
