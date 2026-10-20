import { it } from "@effect/vitest"
import { runMigrations } from "@shoalwork/db"
import { withRawTempDb, withTempDb } from "@shoalwork/db/testing"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { MAX_CHUNK_CHARS } from "../../src/indexer/chunk.js"
import { Indexer } from "../../src/indexer/indexer.js"
import { CodeChunkRow } from "../../src/indexer/rows.js"
import { decodeEmbedding, EMBED_DIMS } from "../../src/rows.js"
import { APP_TS, removeFromRepo, writeInRepo } from "../fixtures/repo/files.js"
import { countingEmbedder, indexerEnv, selectiveEmbedder, withFixtureRepo } from "./helpers.js"

const layout = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly start_line: number
      readonly end_line: number
    }>`SELECT start_line, end_line FROM code_chunks WHERE path = ${path} ORDER BY start_line`
    return rows.map((row) => [row.start_line, row.end_line])
  })

const countRows = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly n: number
    }>`SELECT count(*) AS n FROM code_chunks WHERE path = ${path}`
    return rows[0]?.n ?? 0
  })

const ftsHits = (term: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return (yield* sql`SELECT rowid FROM code_fts WHERE code_fts MATCH ${term}`).length
  })

describe("code_chunks migration", () => {
  it.effect("applies 0007_code_chunks.sql once", () =>
    Effect.gen(function* () {
      expect(yield* runMigrations).toContain("0007_code_chunks.sql")
      expect(yield* runMigrations).toEqual([])
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("keeps code_fts in step with inserts, updates and deletes and enforces the unique key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const insert = (id: string, startLine: number, content: string) =>
        sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, content, indexed_at)
          VALUES (${id}, 'r', 'a.ts', ${startLine}, ${startLine + 1}, 'h', 'ts', ${content}, '2026-10-20T00:00:00.000Z')`
      yield* insert("chk_1", 1, "gato preto")
      expect(yield* ftsHits("gato")).toBe(1)
      yield* sql`UPDATE code_chunks SET content = 'cachorro marrom' WHERE id = 'chk_1'`
      expect(yield* ftsHits("gato")).toBe(0)
      expect(yield* ftsHits("cachorro")).toBe(1)
      expect(yield* ftsHits("path:a")).toBe(1)
      const duplicate = yield* Effect.flip(insert("chk_2", 1, "outro"))
      expect(duplicate._tag).toBe("SqlError")
      yield* sql`DELETE FROM code_chunks WHERE id = 'chk_1'`
      expect(yield* ftsHits("cachorro")).toBe(0)
      const [row] = yield* sql<{ readonly symbols: string }>`SELECT symbols FROM code_chunks`
      expect(row).toBeUndefined()
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("Indexer.index", () => {
  it.effect("indexes the fixture repo into chunks with embeddings, symbols and a lexical index", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const sql = yield* SqlClient
        const report = yield* indexer.index(repo.dir)
        expect(report.files).toBe(5)
        expect(report.filesChanged).toBe(5)
        expect(report.filesRemoved).toBe(0)
        expect(yield* layout("src/app.ts")).toEqual([
          [1, 1],
          [3, 5],
          [7, 9],
          [11, 13],
        ])
        expect(yield* layout("tools/util.py")).toEqual([
          [1, 1],
          [3, 4],
          [6, 7],
          [9, 10],
        ])
        expect(yield* layout("src/lib.rs")).toEqual([
          [1, 1],
          [3, 5],
          [7, 9],
          [11, 13],
        ])
        expect(yield* layout("notes.md")).toEqual([
          [1, 60],
          [51, 70],
        ])
        expect(yield* countRows("assets/blob.bin")).toBe(0)
        expect(yield* countRows("big.ts")).toBe(0)
        expect(report.chunks).toBe(4 + 4 + 4 + 2 + 1)
        expect(report.chunksEmbedded).toBe(report.chunks)
        expect(embedder.calls.reduce((a, b) => a + b, 0)).toBe(report.chunks)

        const rows = yield* Schema.decodeUnknownEffect(Schema.Array(CodeChunkRow))(
          yield* sql`SELECT * FROM code_chunks WHERE path = 'src/app.ts' ORDER BY start_line`,
        )
        expect(rows.map((row) => row.symbols)).toEqual([[], ["alpha"], ["beta"], ["Gamma"]])
        expect(rows.every((row) => row.repo === report.repo && row.lang === "ts")).toBe(true)
        const [first] = rows
        expect(first?.embedding).not.toBeNull()
        expect((yield* decodeEmbedding(first?.embedding ?? new Uint8Array())).length).toBe(EMBED_DIMS)
        expect(yield* ftsHits("alpha")).toBeGreaterThan(0)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder.layer)))
  })

  it.effect("does nothing when run again on an unchanged repo", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const sql = yield* SqlClient
        yield* indexer.index(repo.dir)
        const before = yield* sql`SELECT id, indexed_at FROM code_chunks ORDER BY id`
        const callsBefore = embedder.calls.length
        const second = yield* indexer.index(repo.dir)
        expect(second.filesChanged).toBe(0)
        expect(second.chunksEmbedded).toBe(0)
        expect(embedder.calls.length).toBe(callsBefore)
        expect(yield* sql`SELECT id, indexed_at FROM code_chunks ORDER BY id`).toEqual(before)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder.layer)))
  })

  it.effect("reindexes only the edited file and embeds only the chunk whose content changed", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        embedder.calls.length = 0
        embedder.texts.length = 0

        // alpha grows by one line: beta and Gamma keep their content and only move down one line.
        writeInRepo(
          repo,
          "src/app.ts",
          APP_TS.replace("  return a + 1", "  const next = a + 1\n  return next"),
        )
        const report = yield* indexer.index(repo.dir)
        expect(report.filesChanged).toBe(1)
        expect(report.chunksEmbedded).toBe(1)
        expect(report.chunksReused).toBe(3)
        expect(embedder.calls).toEqual([1])
        expect(embedder.texts[0]).toContain("const next = a + 1")
        expect(yield* layout("src/app.ts")).toEqual([
          [1, 1],
          [3, 6],
          [8, 10],
          [12, 14],
        ])
        expect(yield* countRows("src/lib.rs")).toBe(4)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder.layer)))
  })

  it.effect("deletes the chunks of a removed file, including their lexical entries", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        expect(yield* ftsHits("compute")).toBeGreaterThan(0)
        const callsBefore = embedder.calls.length
        removeFromRepo(repo, "src/lib.rs")
        const report = yield* indexer.index(repo.dir)
        expect(report.filesRemoved).toBe(1)
        expect(report.files).toBe(4)
        expect(yield* countRows("src/lib.rs")).toBe(0)
        expect(yield* ftsHits("compute")).toBe(0)
        expect(embedder.calls.length).toBe(callsBefore)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder.layer)))
  })

  it.effect("drops the chunks of a file that stops being indexable", () => {
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        const leaked = ["sk", "ant", "z".repeat(40)].join("-")
        writeInRepo(repo, "tools/util.py", `TOKEN = "${leaked}"\n`)
        const report = yield* indexer.index(repo.dir)
        expect(report.filesRemoved).toBe(1)
        expect(yield* countRows("tools/util.py")).toBe(0)
      }),
    ).pipe(Effect.provide(indexerEnv()))
  })

  it.effect("isolates an embedding failure to its file and reports it", () => {
    const embedder = selectiveEmbedder("note line 7")
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.index(repo.dir)
        expect(report.failed.map((failure) => failure.path)).toEqual(["notes.md"])
        expect(report.failed[0]?.reason).toContain("embed")
        expect(report.filesChanged).toBe(4)
        expect(report.chunks).toBe(4 + 4 + 4 + 1)
        expect(yield* countRows("notes.md")).toBe(0)
        expect(yield* countRows("src/app.ts")).toBe(4)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder)))
  })

  it.effect("sends the embedder bounded text even for huge lines", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo(
      (repo) =>
        Effect.gen(function* () {
          const indexer = yield* Indexer
          yield* indexer.index(repo.dir)
          expect(embedder.texts.length).toBeGreaterThan(0)
          expect(embedder.texts.every((text) => text.length <= MAX_CHUNK_CHARS)).toBe(true)
        }),
      { "bundle.js": `${"var a=1;".repeat(100_000)}\n` },
    ).pipe(Effect.provide(indexerEnv(embedder.layer, { maxFileBytes: 2_000_000 })))
  })

  it.effect("keeps repos apart in the same database", () => {
    const embedder = countingEmbedder()
    return withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const sql = yield* SqlClient
        const a = yield* indexer.index(repo.dir, { repo: "repo-a" })
        const b = yield* indexer.index(repo.dir, { repo: "repo-b" })
        expect(a.repo).toBe("repo-a")
        expect(b.chunksEmbedded).toBe(b.chunks)
        const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM code_chunks`
        expect(rows[0]?.n).toBe(a.chunks + b.chunks)
      }),
    ).pipe(Effect.provide(indexerEnv(embedder.layer)))
  })
})
