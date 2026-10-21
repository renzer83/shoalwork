import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { CalibrationEntry } from "./tokenizer-approx.js"

// Rows of tokenizer_calibration (0029). A row that does not decode is a bug in what wrote it, so it is a defect.
const Row = Schema.Struct({
  executor: Schema.String,
  lang: Schema.Literals(["code", "prose_pt", "prose_en"]),
  factor: Schema.Number,
  n: Schema.Int,
})
const RowsOf = Schema.Array(Row)

// Every stored factor, to be handed to TokenizerLive at boot.
export const loadCalibration: Effect.Effect<
  ReadonlyArray<CalibrationEntry>,
  SqlError,
  SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT executor, lang, factor, n FROM tokenizer_calibration`
  return yield* Schema.decodeUnknownEffect(RowsOf)(rows).pipe(Effect.orDie)
})

// Upserts the factor of one (executor, lang). `updatedAt` is ISO-8601 UTC, given by the caller.
export const saveCalibration = (
  entry: CalibrationEntry,
  updatedAt: string,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`INSERT INTO tokenizer_calibration (executor, lang, factor, n, updated_at)
      VALUES (${entry.executor}, ${entry.lang}, ${entry.factor}, ${entry.n}, ${updatedAt})
      ON CONFLICT (executor, lang) DO UPDATE SET factor = excluded.factor, n = excluded.n, updated_at = excluded.updated_at`
  })
