import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { makeDbLayer } from "../src/client.js"
import { runMigrations } from "../src/migrator.js"
import { withRawTempDb, withTempDb } from "../src/testing.js"

const tableNames = (sql: SqlClient) =>
  sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`

describe("runMigrations", () => {
  it.effect("applies 0001 to a fresh database", () =>
    Effect.gen(function* () {
      const applied = yield* runMigrations
      expect(applied).toEqual([
        "0001_events_jobs.sql",
        "0002_bots.sql",
        "0003_chat_sessions.sql",
        "0004_tasks.sql",
        "0005_telegram.sql",
        "0006_memory.sql",
        "0007_code_chunks.sql",
        "0008_control.sql",
        "0009_bot_proposals.sql",
        "0010_task_processes.sql",
        "0011_mcp_tokens.sql",
        "0012_tides.sql",
        "0013_webhook_deliveries.sql",
        "0014_plans.sql",
        "0015_pods.sql",
        "0016_approvals.sql",
        "0017_approval_mode.sql",
        "0018_factory.sql",
        "0019_kanban.sql",
        "0020_secrets.sql",
        "0021_factory_agents.sql",
        "0022_cycle.sql",
        "0023_rank.sql",
        "0024_executor_quality.sql",
        "0025_executor_quota.sql",
        "0026_github_installations.sql",
        "0027_notion_sync.sql",
      ])
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("creates tides with a timezone column and one tide per bot and name", () =>
    Effect.gen(function* () {
      yield* runMigrations
      const sql = yield* SqlClient
      const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info('tides')`
      expect(columns.map((row) => row.name)).toEqual(
        expect.arrayContaining(["timezone", "locked_at", "next_run_at"]),
      )
      const indexes = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_index_list('tides')`
      expect(indexes.length).toBeGreaterThan(1)
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("a second run applies nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations
      const again = yield* runMigrations
      expect(again).toEqual([])
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("creates events, jobs and schema_migrations tables", () =>
    Effect.gen(function* () {
      yield* runMigrations
      const sql = yield* SqlClient
      const names = (yield* tableNames(sql)).map((row) => row.name)
      expect(names).toEqual(expect.arrayContaining(["events", "jobs", "schema_migrations"]))
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("creates mcp_tokens keyed by the token hash, with no column for the token itself", () =>
    Effect.gen(function* () {
      yield* runMigrations
      const sql = yield* SqlClient
      const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info('mcp_tokens')`
      const names = columns.map((row) => row.name)
      expect(names).toEqual(
        expect.arrayContaining(["token_hash", "bot_id", "repo", "task_id", "expires_at", "revoked_at"]),
      )
      expect(names).not.toContain("token")
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("creates the parent directory of the database file", () =>
    Effect.gen(function* () {
      const base = mkdtempSync(join(tmpdir(), "shoalwork-test-dir-"))
      const nested = join(base, "nested", "dir", "shoalwork.db")
      try {
        yield* runMigrations.pipe(Effect.provide(makeDbLayer(nested)))
        const applied = yield* runMigrations.pipe(Effect.provide(makeDbLayer(nested)))
        expect(applied).toEqual([])
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }),
  )
})

describe("makeDbLayer PRAGMAs", () => {
  it.effect("opens the database in WAL mode with foreign keys on", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const [journal] = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`
      const [fk] = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
      expect(journal?.journal_mode).toBe("wal")
      expect(fk?.foreign_keys).toBe(1)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("exposes the SqliteClient service alongside SqlClient", () =>
    Effect.gen(function* () {
      const native = yield* SqliteClient.SqliteClient
      expect(native.config.filename.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(withTempDb())),
  )
})
