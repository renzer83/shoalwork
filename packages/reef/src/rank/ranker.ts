import { ConfigError } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { makeGraphLoader } from "./graph.js"
import { importDistances } from "./imports.js"
import {
  DEFAULT_WEIGHTS,
  importsSignal,
  minMax,
  normalizePath,
  proximitySignal,
  RankWeights,
  RankWeightsJson,
  SIGNALS,
  type Signal,
  type SignalValues,
  successSignal,
  type Weights,
} from "./signals.js"

export const WEIGHTS_NAME = "default"

export interface Candidate {
  readonly id: string
  readonly kind: "chunk" | "memory"
  readonly path?: string
  readonly text: string
  // Raw (not yet normalized) signals the caller already has. The ranker fills the ones it can compute itself.
  readonly raw: Partial<Record<Signal, number>>
}

export type RankedCandidate = Candidate & {
  readonly score: number
  // weight * normalized signal, per signal.
  readonly contrib: SignalValues
  // The normalized signals (min-max inside the batch), kept to re-rank offline with other weights.
  readonly signals: SignalValues
}

export interface RankContext {
  readonly repo?: string
  readonly activeFiles: ReadonlyArray<string>
  readonly query: string
}

export type RankError = SqlError | ConfigError

export interface RankerShape {
  readonly rank: (
    candidates: ReadonlyArray<Candidate>,
    ctx: RankContext,
  ) => Effect.Effect<ReadonlyArray<RankedCandidate>, RankError>
  readonly weights: () => Effect.Effect<Weights, RankError>
}

export class Ranker extends Context.Service<Ranker, RankerShape>()("@shoalwork/Ranker") {}

const zeros = (): Record<Signal, number> => ({
  bm25: 0,
  cosine: 0,
  recency: 0,
  imports: 0,
  success: 0,
  proximity: 0,
})

// Pure: normalizes every signal inside the batch, applies the weights, orders by score (ties by id).
export const scoreBatch = (
  candidates: ReadonlyArray<Candidate>,
  weights: Weights,
): ReadonlyArray<RankedCandidate> => {
  const normalized = new Map<Signal, ReadonlyArray<number>>(
    SIGNALS.map((signal) => [signal, minMax(candidates.map((candidate) => candidate.raw[signal]))]),
  )
  const ranked = candidates.map((candidate, index): RankedCandidate => {
    const signals = zeros()
    const contrib = zeros()
    let score = 0
    for (const signal of SIGNALS) {
      const value = normalized.get(signal)?.[index] ?? 0
      signals[signal] = value
      contrib[signal] = weights[signal] * value
      score += contrib[signal]
    }
    return { ...candidate, score, contrib, signals }
  })
  return ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const decodeWeightsRow = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ weights: Schema.String })))
const decodeSuccess = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ chunk_id: Schema.String, ok: Schema.Int, fail: Schema.Int })),
)

const configError = (key: string) => (cause: Schema.SchemaError) =>
  new ConfigError({ key, message: cause.message })

// A database failure stays a SqlError; text that does not decode is a ConfigError.
const keepSql =
  (key: string) =>
  (cause: SqlError | Schema.SchemaError): SqlError | ConfigError =>
    cause._tag === "SchemaError" ? configError(key)(cause) : cause

// Weights stored by the weekly tuning, or undefined when there is no row. A row that does not decode, or whose
// weights do not add up to 1, is a ConfigError: ranking with weights nobody validated would hide the problem.
export const storedWeights = (sql: SqlClient): Effect.Effect<Weights | undefined, RankError> =>
  Effect.gen(function* () {
    const rows = yield* decodeWeightsRow(
      yield* sql`SELECT weights FROM rank_weights WHERE name = ${WEIGHTS_NAME}`,
    ).pipe(Effect.mapError(keepSql(`rank_weights.${WEIGHTS_NAME}`)))
    const [row] = rows
    if (row === undefined) return undefined
    return yield* Schema.decodeUnknownEffect(RankWeightsJson)(row.weights).pipe(
      Effect.mapError(configError(`rank_weights.${WEIGHTS_NAME}`)),
    )
  })

// Stores the weights the ranker will read next time. Weights that are not valid (sum != 1, out of [0, 1]) are refused
// with a ConfigError and nothing is written: a stored row that does not decode would break every later ranking.
export const saveWeights = (sql: SqlClient, weights: Weights): Effect.Effect<void, RankError> =>
  Schema.decodeUnknownEffect(RankWeights)(weights).pipe(
    Effect.mapError(configError("rank_weights.save")),
    Effect.flatMap(
      (valid) =>
        sql`INSERT INTO rank_weights (name, weights, updated_at) VALUES (${WEIGHTS_NAME}, ${JSON.stringify(valid)}, ${nowIso()})
        ON CONFLICT (name) DO UPDATE SET weights = excluded.weights, updated_at = excluded.updated_at`,
    ),
    Effect.asVoid,
  )

export interface RankerOptions {
  // The weights of config/context.yaml (rank.weights). The stored ones win.
  readonly weights?: Weights | undefined
}

const checkedDefaults = (options: RankerOptions): Effect.Effect<Weights, ConfigError> =>
  Schema.decodeUnknownEffect(RankWeights)(options.weights ?? DEFAULT_WEIGHTS).pipe(
    Effect.mapError(configError("rank.weights")),
  )

export const RankerLive = (options: RankerOptions = {}): Layer.Layer<Ranker, ConfigError, SqlClient> =>
  Layer.effect(
    Ranker,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const fallback = yield* checkedDefaults(options)
      const loadGraph = makeGraphLoader(sql)
      const weights = () => storedWeights(sql).pipe(Effect.map((stored) => stored ?? fallback))

      // Signals the candidate did not bring: success history, proximity and imports (recency, bm25 and cosine come from
      // the search that produced the candidate).
      const enrich = (
        candidates: ReadonlyArray<Candidate>,
        ctx: RankContext,
      ): Effect.Effect<ReadonlyArray<Candidate>, RankError> =>
        Effect.gen(function* () {
          const active = ctx.activeFiles.map(normalizePath)
          const chunkIds = candidates
            .filter((c) => c.kind === "chunk" && c.raw.success === undefined)
            .map((c) => c.id)
          const history = new Map<string, number>()
          if (ctx.repo !== undefined && chunkIds.length > 0) {
            const rows = yield* decodeSuccess(
              yield* sql`SELECT chunk_id, ok, fail FROM chunk_success WHERE repo = ${ctx.repo} AND ${sql.in("chunk_id", chunkIds)}`,
            ).pipe(Effect.mapError(keepSql("chunk_success")))
            for (const row of rows) history.set(row.chunk_id, successSignal(row.ok, row.fail))
          }
          const needsGraph =
            ctx.repo !== undefined &&
            active.length > 0 &&
            candidates.some((c) => c.path !== undefined && c.raw.imports === undefined)
          const distances =
            needsGraph && ctx.repo !== undefined
              ? importDistances(
                  yield* loadGraph(ctx.repo).pipe(Effect.mapError(keepSql("code_chunks"))),
                  active,
                )
              : new Map<string, number>()
          return candidates.map((candidate): Candidate => {
            const raw: Partial<Record<Signal, number>> = { ...candidate.raw }
            if (candidate.kind === "chunk" && raw.success === undefined) {
              raw.success = history.get(candidate.id) ?? successSignal(0, 0)
            }
            if (candidate.path !== undefined) {
              const path = normalizePath(candidate.path)
              if (raw.proximity === undefined) raw.proximity = proximitySignal(path, active)
              if (raw.imports === undefined) raw.imports = importsSignal(distances.get(path))
            }
            return { ...candidate, raw }
          })
        })

      return {
        weights,
        rank: (candidates, ctx) =>
          Effect.gen(function* () {
            if (candidates.length === 0) return []
            const resolved = yield* weights()
            return scoreBatch(yield* enrich(candidates, ctx), resolved)
          }),
      }
    }),
  )

// No database: ranks on the raw signals the candidates bring, with fixed weights.
export const RankerTest = (weights: Weights = DEFAULT_WEIGHTS): Layer.Layer<Ranker> =>
  Layer.succeed(Ranker, {
    weights: () => Effect.succeed(weights),
    rank: (candidates) => Effect.sync(() => scoreBatch(candidates, weights)),
  })
