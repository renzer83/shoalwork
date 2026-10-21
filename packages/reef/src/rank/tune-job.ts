import { Beacon } from "@shoalwork/beacon"
import { EventPayloads, streamIds } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  MAX_TUNE_SAMPLES,
  type RankTuneReport,
  rankTune,
  type TuneCandidate,
  type TuneSample,
} from "./feedback.js"
import type { RankError } from "./ranker.js"
import { DEFAULT_WEIGHTS, type SignalValues, type Weights } from "./signals.js"

const Assembled = Schema.fromJsonString(EventPayloads["context.assembled"])
const Finished = Schema.fromJsonString(EventPayloads["executor.finished"])
const Rows = Schema.Array(Schema.Struct({ assembled: Schema.String, finished: Schema.NullOr(Schema.String) }))
const decodeRows = Schema.decodeUnknownEffect(Rows)

const signalValues = (tuple: readonly [number, number, number, number, number, number]): SignalValues => ({
  bm25: tuple[0],
  cosine: tuple[1],
  recency: tuple[2],
  imports: tuple[3],
  success: tuple[4],
  proximity: tuple[5],
})

// The last `limit` briefings that ranked code, newest first, each with the verdict of the run that used it: the first
// executor.finished after the context.assembled in the same task stream. A run that ended in anything but ok or failed
// (blocked, budget, approval) says nothing about the chunks and is left out.
export const collectTuneSamples = (
  limit: number = MAX_TUNE_SAMPLES,
): Effect.Effect<ReadonlyArray<TuneSample>, SqlError | Schema.SchemaError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* decodeRows(
      yield* sql`SELECT assembled, finished FROM (
          SELECT a.position AS position, a.payload AS assembled,
            (SELECT f.payload FROM events f
              WHERE f.type = 'executor.finished' AND f.stream_id = a.stream_id AND f.position > a.position
              ORDER BY f.position LIMIT 1) AS finished
          FROM events a
          WHERE a.type = 'context.assembled' AND json_extract(a.payload, '$.ranked') IS NOT NULL)
        WHERE json_extract(finished, '$.verdict.kind') IN ('ok', 'failed')
        ORDER BY position DESC LIMIT ${limit}`,
    )
    const samples: Array<TuneSample> = []
    for (const row of rows) {
      if (row.finished === null) continue
      const verdict = (yield* Schema.decodeUnknownEffect(Finished)(row.finished)).verdict.kind
      if (verdict !== "ok" && verdict !== "failed") continue
      const assembled = yield* Schema.decodeUnknownEffect(Assembled)(row.assembled)
      const candidates: ReadonlyArray<TuneCandidate> = (assembled.ranked ?? []).map((entry) => ({
        id: entry.id,
        used: entry.used,
        signals: signalValues(entry.signals),
      }))
      samples.push({ ok: verdict === "ok", candidates })
    }
    return samples
  })

// The weekly rank-tune: tunes on the last 200 recorded briefings, stores the weights when they improve and records
// context.weights_updated. `fallback` are the weights of config/context.yaml.
export const runRankTune = (
  fallback: Weights = DEFAULT_WEIGHTS,
): Effect.Effect<RankTuneReport, RankError | Schema.SchemaError, SqlClient | Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const report = yield* rankTune(yield* collectTuneSamples(), fallback)
    if (report.changed) {
      yield* beacon
        .append({
          streamId: streamIds.system,
          type: "context.weights_updated",
          payload: {
            before: report.before,
            after: report.weights,
            samples: report.samples,
            objectiveBefore: report.objectiveBefore,
            objectiveAfter: report.objectiveAfter,
          },
          actor: "system:rank-tune",
          correlationId: "rank-tune",
        })
        .pipe(
          Effect.catchTag("SchemaViolation", (error) => Effect.die(error)),
          Effect.catchTag("Conflict", (error) => Effect.die(error)),
        )
    }
    return report
  })
