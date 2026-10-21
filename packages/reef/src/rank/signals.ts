import { posix } from "node:path"
import { Schema } from "effect"

export const SIGNALS = ["bm25", "cosine", "recency", "imports", "success", "proximity"] as const
export type Signal = (typeof SIGNALS)[number]
export type Weights = Readonly<Record<Signal, number>>
export type SignalValues = Readonly<Record<Signal, number>>

export const DEFAULT_WEIGHTS: Weights = {
  bm25: 0.25,
  cosine: 0.25,
  recency: 0.1,
  imports: 0.15,
  success: 0.15,
  proximity: 0.1,
}

const WEIGHT_TOLERANCE = 1e-6
const Weight = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const sumsToOne = (weights: Weights): true | string => {
  const sum = SIGNALS.reduce((total, signal) => total + weights[signal], 0)
  return Math.abs(sum - 1) <= WEIGHT_TOLERANCE ? true : `weights must add up to 1, they add up to ${sum}`
}

// Six weights in [0, 1] that add up to 1.
export const RankWeights = Schema.Struct({
  bm25: Weight,
  cosine: Weight,
  recency: Weight,
  imports: Weight,
  success: Weight,
  proximity: Weight,
}).check(Schema.makeFilter(sumsToOne))

export const RankWeightsJson = Schema.fromJsonString(RankWeights)

// Min-max inside the batch. A missing or non-finite value is 0. When every present value is equal there is no range to
// stretch: a positive value is 1, anything else 0.
export const minMax = (values: ReadonlyArray<number | undefined>): ReadonlyArray<number> => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value)) {
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  }
  return values.map((value) => {
    if (value === undefined || !Number.isFinite(value)) return 0
    if (max === min) return value > 0 ? 1 : 0
    return (value - min) / (max - min)
  })
}

const RECENCY_HALF_SCALE_DAYS = 30
const DAY_MS = 86_400_000

// exp(-ageDays / 30); a negative age (clock skew) counts as 0 days.
export const recencySignal = (ageDays: number): number =>
  Math.exp(-Math.max(0, ageDays) / RECENCY_HALF_SCALE_DAYS)

// Age in days of an ISO-8601 instant, or undefined when there is none (never committed, unparsable).
export const ageDaysOf = (iso: string | null | undefined, nowMs: number): number | undefined => {
  if (iso === null || iso === undefined) return undefined
  const at = Date.parse(iso)
  return Number.isNaN(at) ? undefined : (nowMs - at) / DAY_MS
}

export const successSignal = (ok: number, fail: number): number => ok / (ok + fail + 1)

// 1 at distance 1 (imports or is imported by an active file), 0.5 at distance 2, 0 otherwise.
export const importsSignal = (distance: number | undefined): number =>
  distance === 1 ? 1 : distance === 2 ? 0.5 : 0

export const normalizePath = (path: string): string => {
  const normalized = posix.normalize(path.replaceAll("\\", "/"))
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

const CONTAINER_DIRS: ReadonlySet<string> = new Set([
  "packages",
  "services",
  "apps",
  "crates",
  "libs",
  "modules",
])

// The package a path belongs to, by layout: `<container>/<name>` for monorepo containers, else the top-level directory.
// Files at the repo root belong to "".
export const packageRootOf = (path: string): string => {
  const segments = normalizePath(path).split("/")
  const [first, second] = segments
  if (first === undefined || segments.length < 2) return ""
  return CONTAINER_DIRS.has(first) && second !== undefined && segments.length > 2
    ? `${first}/${second}`
    : first
}

// 1 same file as an active one, 0.6 same directory, 0.3 same package, else 0 (best over the active files).
export const proximitySignal = (path: string, activeFiles: ReadonlyArray<string>): number => {
  const here = normalizePath(path)
  const dir = posix.dirname(here)
  const pkg = packageRootOf(here)
  let best = 0
  for (const active of activeFiles) {
    const other = normalizePath(active)
    if (other === here) return 1
    if (posix.dirname(other) === dir) best = Math.max(best, 0.6)
    else if (packageRootOf(other) === pkg) best = Math.max(best, 0.3)
  }
  return best
}
