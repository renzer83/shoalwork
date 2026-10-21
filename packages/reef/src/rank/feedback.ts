import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type RankError, saveWeights, storedWeights } from "./ranker.js"
import {
  DEFAULT_WEIGHTS,
  RankWeights,
  SIGNALS,
  type Signal,
  type SignalValues,
  type Weights,
} from "./signals.js"

export const WEIGHT_STEP = 0.05
export const MIN_TUNE_SAMPLES = 10
export const MAX_TUNE_SAMPLES = 200
const MAX_ROUNDS = 20
// A weight never ends more than this far from the one the tuning started from: small samples cannot flip the ranking.
export const MAX_DRIFT = 0.15
// The margin term only separates moves that flip no ranking yet; it stays below one flipped hit.
const MARGIN_WEIGHT = 0.05
const EPSILON = 1e-9

// Counts one finished task against every chunk its briefing carried: Verdict.ok bumps `ok`, any other verdict `fail`.
export const recordOutcome = (
  repo: string,
  chunkIds: ReadonlyArray<string>,
  ok: boolean,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    if (chunkIds.length === 0) return
    const sql = yield* SqlClient
    const unique = [...new Set(chunkIds)]
    const okDelta = ok ? 1 : 0
    const failDelta = ok ? 0 : 1
    yield* sql.withTransaction(
      Effect.forEach(
        unique,
        (chunkId) =>
          sql`INSERT INTO chunk_success (repo, chunk_id, ok, fail) VALUES (${repo}, ${chunkId}, ${okDelta}, ${failDelta})
            ON CONFLICT (repo, chunk_id) DO UPDATE SET ok = ok + ${okDelta}, fail = fail + ${failDelta}`,
        { discard: true },
      ),
    )
  })

// One recorded briefing, as context.assembled keeps it: every candidate the ranker considered with its normalized
// signals, and whether it went into the briefing. `ok` is the Verdict of the task that ran with it.
export interface TuneCandidate {
  readonly id: string
  readonly used: boolean
  readonly signals: SignalValues
}

export interface TuneSample {
  readonly ok: boolean
  readonly candidates: ReadonlyArray<TuneCandidate>
}

const scoreOf = (signals: SignalValues, weights: Weights): number =>
  SIGNALS.reduce((total, signal) => total + weights[signal] * signals[signal], 0)

const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

// Offline proxy for the ok rate under `weights`. A sample re-ranks its recorded candidates and keeps as many as the
// briefing used; the share of them that were really used counts for the sample when the task went ok and against it
// when it did not. A small margin term (mean score of the used candidates minus the mean of the others, same sign)
// gives the search a slope across the plateaus between two rankings. Weights that push the chunks of good tasks up and
// the chunks of bad tasks down score higher.
export const objective = (samples: ReadonlyArray<TuneSample>, weights: Weights): number => {
  let total = 0
  for (const sample of samples) {
    const scored = sample.candidates.map((candidate) => ({
      candidate,
      score: scoreOf(candidate.signals, weights),
    }))
    const used = scored.filter((entry) => entry.candidate.used)
    if (used.length === 0) continue
    const top = [...scored]
      .sort((a, b) => b.score - a.score || (a.candidate.id < b.candidate.id ? -1 : 1))
      .slice(0, used.length)
    const hits = top.filter((entry) => entry.candidate.used).length
    const margin =
      mean(used.map((entry) => entry.score)) -
      mean(scored.filter((e) => !e.candidate.used).map((e) => e.score))
    total += (sample.ok ? 1 : -1) * (hits / used.length + MARGIN_WEIGHT * margin)
  }
  return total
}

const round2 = (value: number): number => Math.round(value * 100) / 100

const GRID_UNITS = Math.round(1 / WEIGHT_STEP)

// The weights moved onto the WEIGHT_STEP grid with their sum kept at exactly 1: each weight is floored to a whole number
// of steps and the steps left over go to the largest remainders (ties in SIGNALS order). Weights already on the grid
// (and any set that adds up to 1 on it) come back unchanged.
export const snapToGrid = (weights: Weights): Weights => {
  const exact = SIGNALS.map((signal) => Math.max(0, weights[signal]) / WEIGHT_STEP)
  const units = exact.map((value) => Math.floor(value + EPSILON))
  let left = GRID_UNITS - units.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - (units[index] ?? 0) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (let turn = 0; left > 0; turn = (turn + 1) % SIGNALS.length, left--) {
    const entry = byRemainder[turn]
    if (entry !== undefined) units[entry.index] = (units[entry.index] ?? 0) + 1
  }
  // Rounding up may have overshot (weights summing above 1): take the steps back from the largest.
  while (left < 0) {
    const biggest = units.indexOf(Math.max(...units))
    units[biggest] = (units[biggest] ?? 0) - 1
    left++
  }
  const snapped = (signal: Signal): number => round2((units[SIGNALS.indexOf(signal)] ?? 0) * WEIGHT_STEP)
  return {
    bm25: snapped("bm25"),
    cosine: snapped("cosine"),
    recency: snapped("recency"),
    imports: snapped("imports"),
    success: snapped("success"),
    proximity: snapped("proximity"),
  }
}

export interface TuneResult {
  readonly weights: Weights
  readonly before: number
  readonly after: number
}

// Light grid search: the start is put on the grid of WEIGHT_STEP (sum 1), then each round moves WEIGHT_STEP from one
// weight to another (the sum stays 1, no weight strays more than MAX_DRIFT from the snapped start) and keeps the best
// move when it raises the objective; stops when no move does. With no improving move the start comes back as it was.
// Deterministic: ties keep the earlier move in SIGNALS order.
export const tuneWeights = (samples: ReadonlyArray<TuneSample>, original: Weights): TuneResult => {
  const used = samples.slice(0, MAX_TUNE_SAMPLES)
  const start = snapToGrid(original)
  let current = start
  let best = objective(used, current)
  const before = objective(used, original)
  let moved = false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let next: Weights | undefined
    let nextScore = best
    for (const receiver of SIGNALS) {
      for (const donor of SIGNALS) {
        if (receiver === donor || current[donor] < WEIGHT_STEP - EPSILON) continue
        const candidate: Record<Signal, number> = { ...current }
        candidate[receiver] = round2(current[receiver] + WEIGHT_STEP)
        candidate[donor] = round2(current[donor] - WEIGHT_STEP)
        if (
          Math.abs(candidate[receiver] - start[receiver]) > MAX_DRIFT + EPSILON ||
          Math.abs(candidate[donor] - start[donor]) > MAX_DRIFT + EPSILON
        ) {
          continue
        }
        const score = objective(used, candidate)
        if (score > nextScore + EPSILON) {
          next = candidate
          nextScore = score
        }
      }
    }
    if (next === undefined) break
    current = next
    best = nextScore
    moved = true
  }
  return moved ? { weights: current, before, after: best } : { weights: original, before, after: before }
}

export interface RankTuneReport {
  readonly changed: boolean
  readonly samples: number
  readonly weights: Weights
  readonly before: Weights
  readonly objectiveBefore: number
  readonly objectiveAfter: number
}

// The weekly `rank-tune`: tunes the stored weights (or `fallback`, the config ones) on the last tasks and stores the
// result in rank_weights when it is better. Too few samples change nothing. The caller records context.weights_updated.
export const rankTune = (
  samples: ReadonlyArray<TuneSample>,
  fallback: Weights = DEFAULT_WEIGHTS,
): Effect.Effect<RankTuneReport, RankError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const before = (yield* storedWeights(sql)) ?? fallback
    const considered = Math.min(samples.length, MAX_TUNE_SAMPLES)
    if (samples.length < MIN_TUNE_SAMPLES) {
      const objectiveNow = objective(samples, before)
      return {
        changed: false,
        samples: considered,
        weights: before,
        before,
        objectiveBefore: objectiveNow,
        objectiveAfter: objectiveNow,
      }
    }
    const tuned = tuneWeights(samples, before)
    const moved = SIGNALS.some((signal) => tuned.weights[signal] !== before[signal])
    // Weights that are not valid are never stored: a bad row would make every later ranking a ConfigError.
    const valid = Schema.is(RankWeights)(tuned.weights)
    if (moved && !valid) yield* Effect.logWarning("rank-tune produced invalid weights, nothing stored")
    const changed = moved && valid
    if (changed) yield* saveWeights(sql, tuned.weights)
    return {
      changed,
      samples: considered,
      weights: tuned.weights,
      before,
      objectiveBefore: tuned.before,
      objectiveAfter: tuned.after,
    }
  })
