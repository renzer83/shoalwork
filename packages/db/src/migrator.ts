import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { nowIso } from "./now.js"

// Own runner: effect/sql Migrator only loads .js/.ts modules, not .sql files.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url))
const MIGRATION_FILE = /^\d{4}_.+\.sql$/

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)`

// Statements end with ';' at end of line. Full-line "--" comments are dropped.
const splitStatements = (script: string): ReadonlyArray<string> =>
  script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;[ \t\r]*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

const listMigrations: Effect.Effect<ReadonlyArray<string>> = Effect.sync(() =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort(),
)

const readMigration = (file: string): Effect.Effect<string> =>
  Effect.sync(() => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))

// Each migration runs in its own write transaction (BEGIN IMMEDIATE via the driver).
// The "already applied" check is inside that transaction, so concurrent runners cannot apply it twice.
export const runMigrations: Effect.Effect<ReadonlyArray<string>, SqlError, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient
    const files = yield* listMigrations
    yield* sql.unsafe(CREATE_MIGRATIONS_TABLE)

    const applied: Array<string> = []
    for (const file of files) {
      const wasApplied = yield* sql.withTransaction(
        Effect.gen(function* () {
          const seen = yield* sql<{
            readonly name: string
          }>`SELECT name FROM schema_migrations WHERE name = ${file}`
          if (seen.length > 0) {
            return false
          }
          const script = yield* readMigration(file)
          for (const statement of splitStatements(script)) {
            yield* sql.unsafe(statement)
          }
          yield* sql`INSERT INTO schema_migrations (name, applied_at) VALUES (${file}, ${nowIso()})`
          return true
        }),
      )
      if (wasApplied) {
        applied.push(file)
      }
    }
    return applied
  },
)
