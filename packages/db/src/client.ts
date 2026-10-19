import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Config, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqlError, UnknownError } from "effect/sql/SqlError"

export const DbConfig = Config.all({
  path: Config.String("DATABASE_PATH").pipe(Config.withDefault("./data/shoalwork.db")),
})

// The driver already sets WAL and busy_timeout (5s); they are repeated here so the boot contract is explicit.
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = NORMAL",
] as const

const ensureParentDir = (filename: string): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => mkdirSync(dirname(filename), { recursive: true }),
    catch: (cause) =>
      new SqlError({
        reason: new UnknownError({ message: `cannot create database directory for ${filename}`, cause }),
      }),
  })

const applyPragmas = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient
    for (const pragma of PRAGMAS) {
      yield* sql.unsafe(pragma)
    }
  }),
)

export const makeDbLayer = (filename: string): Layer.Layer<SqlClient | SqliteClient.SqliteClient, SqlError> =>
  Layer.provideMerge(
    applyPragmas,
    Layer.unwrap(Effect.as(ensureParentDir(filename), SqliteClient.layer({ filename }))),
  )

export const DbLive: Layer.Layer<SqlClient | SqliteClient.SqliteClient, Config.ConfigError | SqlError> =
  Layer.unwrap(Effect.map(DbConfig, ({ path }) => makeDbLayer(path)))
