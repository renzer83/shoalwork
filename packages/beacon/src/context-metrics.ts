import { type Event, EventPayloads } from "@shoalwork/contracts"
import { DateTime, Option, Schema } from "effect"

const decodeUsageRecorded = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])

const decodeExecutorStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])
const decodeExecutorFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])
const decodeContextAssembled = Schema.decodeUnknownOption(EventPayloads["context.assembled"])

// Context metrics (T-102). A run is an executor.finished paired with the executor.started of the same task and step;
// the usage.recorded between the two is its tokensIn (same pairing as the §16 quality job). A finished without its
// started in the events cannot be paired: its tokens are unknown, so it is counted in `unpaired` and left out of the
// averages. Pass the events in log order.
export type ContextBy = "task" | "bot" | "executor" | "level"

export interface ContextRun {
  readonly taskId: string
  readonly botId: string
  readonly executor: string
  readonly level: string
  readonly ok: boolean
  readonly tokensIn: number
  // `used` of the latest context.assembled of the task before the run ended; undefined when there is none.
  readonly contextUsed: number | undefined
  readonly at: number
}

export interface ContextRuns {
  readonly runs: ReadonlyArray<ContextRun>
  readonly unpaired: number
}

export interface ContextTotals {
  readonly n: number
  readonly tokensInAvg: number | null
  readonly okRate: number | null
}

export interface ContextMetricsRow {
  readonly key: string
  readonly n: number
  readonly tokensInAvg: number
  readonly tokensInP90: number
  // Mean `used` over the runs that had a context.assembled; null when none did.
  readonly contextTokensAvg: number | null
  readonly okRate: number
}

// Relative change: tokensInAvgPct in percent of the baseline; okRatePct in percentage points. Null when a side is
// missing or the baseline is zero.
export interface ContextDelta {
  readonly tokensInAvgPct: number | null
  readonly okRatePct: number | null
}

const stepKey = (taskId: string, stepId: string | undefined): string => `${taskId}|${stepId ?? ""}`
const UNKNOWN_LEVEL = "unknown"

interface OpenRun {
  readonly botId: string
  readonly executor: string
  tokensIn: number
}

// Runs whose finished event is in [window.since, window.until) (epoch ms). Unpaired finishes in the window are counted.
export const contextRuns = (
  events: ReadonlyArray<Event>,
  window: { readonly since: number; readonly until: number },
): ContextRuns => {
  const open = new Map<string, OpenRun>()
  const levelByTask = new Map<string, string>()
  const usedByTask = new Map<string, number>()
  const runs: Array<ContextRun> = []
  let unpaired = 0
  for (const event of events) {
    if (event.type === "context.assembled") {
      const payload = Option.getOrUndefined(decodeContextAssembled(event.payload))
      if (payload === undefined) continue
      levelByTask.set(payload.taskId, payload.level)
      usedByTask.set(payload.taskId, payload.used)
    } else if (event.type === "executor.started") {
      const payload = Option.getOrUndefined(decodeExecutorStarted(event.payload))
      if (payload === undefined) continue
      open.set(stepKey(payload.taskId, payload.stepId), {
        botId: payload.botId,
        executor: payload.executor,
        tokensIn: 0,
      })
    } else if (event.type === "usage.recorded") {
      const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
      if (payload === undefined) continue
      const run = open.get(stepKey(payload.taskId, payload.stepId))
      if (run !== undefined) run.tokensIn += payload.usage.tokensIn
    } else if (event.type === "executor.finished") {
      const payload = Option.getOrUndefined(decodeExecutorFinished(event.payload))
      if (payload === undefined) continue
      const key = stepKey(payload.taskId, payload.stepId)
      const run = open.get(key)
      open.delete(key)
      const at = DateTime.toEpochMillis(event.occurredAt)
      if (at < window.since || at >= window.until) continue
      if (run === undefined) {
        unpaired += 1
        continue
      }
      runs.push({
        taskId: payload.taskId,
        botId: run.botId,
        executor: run.executor,
        level: levelByTask.get(payload.taskId) ?? UNKNOWN_LEVEL,
        ok: payload.verdict.kind === "ok",
        tokensIn: run.tokensIn,
        contextUsed: usedByTask.get(payload.taskId),
        at,
      })
    }
  }
  return { runs, unpaired }
}

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

// Nearest rank over sorted values, the same rule as computeMetrics in packages/factory.
const percentileNearest = (sorted: ReadonlyArray<number>, p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0

const contextKey = (run: ContextRun, by: ContextBy): string => {
  switch (by) {
    case "task":
      return run.taskId
    case "bot":
      return run.botId
    case "executor":
      return run.executor
    case "level":
      return run.level
  }
}

// Rows per key, most runs first. Keys with no run do not appear.
export const groupContextRuns = (
  runs: ReadonlyArray<ContextRun>,
  by: ContextBy,
): ReadonlyArray<ContextMetricsRow> => {
  const groups = new Map<string, Array<ContextRun>>()
  for (const run of runs) {
    const key = contextKey(run, by)
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  return Array.from(groups, ([key, group]): ContextMetricsRow => {
    const tokens = group.map((run) => run.tokensIn).sort((x, y) => x - y)
    const used = group.flatMap((run) => (run.contextUsed === undefined ? [] : [run.contextUsed]))
    return {
      key,
      n: group.length,
      tokensInAvg: mean(tokens),
      tokensInP90: percentileNearest(tokens, 0.9),
      contextTokensAvg: used.length === 0 ? null : mean(used),
      okRate: group.filter((run) => run.ok).length / group.length,
    }
  }).sort((x, y) => y.n - x.n || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
}

export const contextTotals = (runs: ReadonlyArray<ContextRun>): ContextTotals => {
  if (runs.length === 0) return { n: 0, tokensInAvg: null, okRate: null }
  return {
    n: runs.length,
    tokensInAvg: mean(runs.map((run) => run.tokensIn)),
    okRate: runs.filter((run) => run.ok).length / runs.length,
  }
}

// Null for any side without runs, and for a zero baseline (no division by zero).
export const contextDelta = (
  current: ContextTotals,
  baseline: { readonly tokensInAvg: number | null; readonly okRate: number | null },
): ContextDelta => {
  const tokensInAvgPct =
    current.tokensInAvg === null || baseline.tokensInAvg === null || baseline.tokensInAvg === 0
      ? null
      : ((current.tokensInAvg - baseline.tokensInAvg) / baseline.tokensInAvg) * 100
  const okRatePct =
    current.okRate === null || baseline.okRate === null ? null : (current.okRate - baseline.okRate) * 100
  return { tokensInAvgPct, okRatePct }
}

// The spec projection: rows per `by` key for [since, until).
export const contextMetrics = (
  events: ReadonlyArray<Event>,
  opts: { readonly since: Date; readonly until: Date; readonly by: ContextBy },
): ReadonlyArray<ContextMetricsRow> =>
  groupContextRuns(
    contextRuns(events, { since: opts.since.getTime(), until: opts.until.getTime() }).runs,
    opts.by,
  )
