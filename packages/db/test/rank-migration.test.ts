import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { withTempDb } from "../src/testing.js"

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`
    return rows.map((row) => row.name)
  })

describe("0023_rank.sql", () => {
  it.effect("adds the commit time cache to code_chunks and creates the ranking tables", () =>
    Effect.gen(function* () {
      expect(yield* columnsOf("code_chunks")).toContain("last_commit_at")
      expect(yield* columnsOf("chunk_success")).toEqual(["repo", "chunk_id", "ok", "fail"])
      expect(yield* columnsOf("rank_weights")).toEqual(["name", "weights", "updated_at"])
      expect(yield* columnsOf("system_tides")).toEqual(["name", "next_run_at", "locked_at"])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("keeps one success row per chunk of a repo and one weights row per name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES ('r', 'c', 1, 0)`
      yield* sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES ('other', 'c', 1, 0)`
      const duplicate = yield* Effect.flip(
        sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES ('r', 'c', 2, 0)`,
      )
      expect(duplicate._tag).toBe("SqlError")
      yield* sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES ('default', '{}', '2026-10-21T00:00:00.000Z')`
      const again = yield* Effect.flip(
        sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES ('default', '{}', 'x')`,
      )
      expect(again._tag).toBe("SqlError")
    }).pipe(Effect.provide(withTempDb())),
  )
})
