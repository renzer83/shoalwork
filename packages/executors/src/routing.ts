import type { ExecutorId, QuotaStatus, TaskKind } from "@shoalwork/contracts"
import { Schema } from "effect"

// The weights of the score (config/model-tiers.yaml → routing.weights). Non-negative and finite.
const Weight = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
export const RouteWeights = Schema.Struct({ quality: Weight, quota: Weight, cost: Weight })
export type RouteWeights = typeof RouteWeights.Type

export const DEFAULT_ROUTE_WEIGHTS: RouteWeights = { quality: 0.6, quota: 0.25, cost: 0.15 }

// The fields of an executor_quality row that the score reads (the full row comes from the beacon projection).
export interface RouteQuality {
  readonly executor: ExecutorId
  readonly kind: TaskKind
  readonly window_days: number
  readonly n: number
  readonly ok_rate: number
  readonly avg_usd: number
}

export interface RouteCtx {
  readonly quality: ReadonlyArray<RouteQuality>
  readonly quota: ReadonlyArray<QuotaStatus>
  readonly weights: RouteWeights
}

export interface RankedExecutor {
  readonly executor: ExecutorId
  readonly score: number
  readonly reasons: string[]
}

// Below this many runs the history says too little: the prior 0.5 is used and the reason "low-n" is reported.
export const MIN_RUNS = 5
const PRIOR_OK_RATE = 0.5
export const QUOTA_EXHAUSTED = "quota-exhausted"
export const LOW_N = "low-n"

// The history used for an executor and kind: the shortest window with enough runs, else the longest window available.
const historyOf = (quality: ReadonlyArray<RouteQuality>, executor: ExecutorId, kind: TaskKind) => {
  const rows = quality
    .filter((row) => row.executor === executor && row.kind === kind)
    .sort((a, b) => a.window_days - b.window_days)
  return rows.find((row) => row.n >= MIN_RUNS) ?? rows.at(-1)
}

// Laplace smoothing of the ok count: (ok + 1) / (n + 2). The row keeps the raw rate, so ok = rate * n.
const smoothedOkRate = (row: RouteQuality | undefined, reasons: string[]): number => {
  if (row === undefined || row.n < MIN_RUNS) {
    reasons.push(LOW_N)
    return PRIOR_OK_RATE
  }
  const ok = Math.round(row.ok_rate * row.n)
  return (ok + 1) / (row.n + 2)
}

interface Scored {
  readonly executor: ExecutorId
  readonly okRate: number
  readonly usedRatio: number
  // undefined when the executor has no history for this kind.
  readonly avgUsd: number | undefined
  readonly reasons: string[]
}

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

// Ranks the candidates for one task kind, best first. score = w.quality * okRate + w.quota * (1 - usedRatio)
// - w.cost * (avg_usd / the highest cost among the eligible; a candidate with no history costs the median of the
// eligible with history). A candidate whose quota is not available is excluded:
// it comes last with score -Infinity and reason "quota-exhausted". Ties keep the order of `candidates` (the yaml order).
// A candidate with no quota status counts as unused. Pure: the caller supplies the quality rows and the quota.
export const rankExecutors = (
  kind: TaskKind,
  candidates: ReadonlyArray<ExecutorId>,
  ctx: RouteCtx,
): ReadonlyArray<RankedExecutor> => {
  const eligible: Array<Scored> = []
  const excluded: Array<RankedExecutor> = []
  for (const executor of candidates) {
    const status = ctx.quota.find((entry) => entry.executor === executor)
    if (status !== undefined && !status.available) {
      excluded.push({ executor, score: Number.NEGATIVE_INFINITY, reasons: [QUOTA_EXHAUSTED] })
      continue
    }
    const reasons: string[] = []
    const row = historyOf(ctx.quality, executor, kind)
    eligible.push({
      executor,
      okRate: smoothedOkRate(row, reasons),
      usedRatio: status?.usedRatio ?? 0,
      avgUsd: row?.avg_usd,
      reasons,
    })
  }
  // A candidate with no history pays the median cost of the eligible candidates that have history. Paying zero would
  // make an unmeasured executor the cheapest one by default.
  const fallbackUsd = median(eligible.flatMap((entry) => (entry.avgUsd === undefined ? [] : [entry.avgUsd])))
  const costOf = (entry: Scored): number => entry.avgUsd ?? fallbackUsd
  const maxUsd = Math.max(0, ...eligible.map(costOf))
  const ranked: Array<RankedExecutor> = eligible
    .map((entry) => ({
      executor: entry.executor,
      score:
        ctx.weights.quality * entry.okRate +
        ctx.weights.quota * (1 - entry.usedRatio) -
        ctx.weights.cost * (maxUsd > 0 ? costOf(entry) / maxUsd : 0),
      reasons: entry.reasons,
    }))
    .sort((a, b) => b.score - a.score)
  return [...ranked, ...excluded]
}
