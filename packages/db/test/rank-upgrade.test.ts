import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { runMigrations } from "../src/migrator.js"
import { withRawTempDb } from "../src/testing.js"

const DIR = fileURLToPath(new URL("../migrations/", import.meta.url))
const RANK = "0023_rank.sql"

// Same statement rule as the runner: full-line "--" comments dropped, statements end with ';' at end of line.
const statements = (script: string): ReadonlyArray<string> =>
  script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;[ \t\r]*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

// A database as it was before the ranking: every migration up to 0022 applied and recorded.
const upToBeforeRank = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql.unsafe(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  )
  const files = readdirSync(DIR)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < RANK)
    .sort()
  for (const file of files) {
    for (const statement of statements(readFileSync(`${DIR}${file}`, "utf8"))) {
      yield* sql.unsafe(statement)
    }
    yield* sql`INSERT INTO schema_migrations (name, applied_at) VALUES (${file}, '2026-10-01T00:00:00.000Z')`
  }
  return files
})

describe("0023_rank.sql on a database that already has chunks", () => {
  it.effect("keeps the chunks, leaves last_commit_at NULL and keeps the full-text search working", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const before = yield* upToBeforeRank
      expect(before.at(-1)).toBe("0022_cycle.sql")
      yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at)
        VALUES ('chk_old', 'r', 'src/old.ts', 1, 3, 'sha', 'ts', '["oldFn"]', 'export function oldFn() { return 1 }', '2026-10-01T00:00:00.000Z')`

      const applied = yield* runMigrations
      expect(applied[0]).toBe(RANK)

      const rows = yield* sql<{
        readonly id: string
        readonly last_commit_at: string | null
      }>`SELECT id, last_commit_at FROM code_chunks`
      expect(rows).toEqual([{ id: "chk_old", last_commit_at: null }])
      const found =
        yield* sql`SELECT c.id FROM code_fts JOIN code_chunks c ON c.rowid = code_fts.rowid WHERE code_fts MATCH 'oldFn'`
      expect(found).toEqual([{ id: "chk_old" }])

      // The column is writable without touching the index, and a new chunk is found as before.
      yield* sql`UPDATE code_chunks SET last_commit_at = '2026-10-20T00:00:00.000Z' WHERE id = 'chk_old'`
      yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at, last_commit_at)
        VALUES ('chk_new', 'r', 'src/new.ts', 1, 3, 'sha2', 'ts', '[]', 'export const newThing = 2', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`
      const both =
        yield* sql`SELECT c.id FROM code_fts JOIN code_chunks c ON c.rowid = code_fts.rowid WHERE code_fts MATCH 'oldFn OR newThing' ORDER BY c.id`
      expect(both).toEqual([{ id: "chk_new" }, { id: "chk_old" }])
    }).pipe(Effect.provide(withRawTempDb())),
  )
})
