import { type Event, EventPayloads, type EventType, type Usage } from "@shoalwork/contracts"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { Beacon } from "./beacon.js"

// Cost report behind GET /costs (02-architecture §14). Pure over the log; readCostEvents is the only reader.

const decodeUsageRecorded = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])
const decodeExecutorStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])
const decodeExecutorFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])
const decodeContextAssembled = Schema.decodeUnknownOption(EventPayloads["context.assembled"])
const decodeTaskReceived = Schema.decodeUnknownOption(EventPayloads["task.received"])

// The only types the report reads. The type filter uses events_type_idx; the time window is applied here.
export const COST_EVENT_TYPES: ReadonlyArray<EventType> = [
  "executor.started",
  "executor.finished",
  "usage.recorded",
  "context.assembled",
]

// The Farol reads the same types plus task.received, which gives each task its tier (by=tier).
export const COST_BY_TIER_TYPES: ReadonlyArray<EventType> = [...COST_EVENT_TYPES, "task.received"]

export type CostBy = "task" | "bot" | "executor" | "tier"

// Half-open window on occurredAt, in epoch ms: [since, until).
export interface CostWindow {
  readonly since: number
  readonly until: number
}

export interface CostRow {
  readonly key: string
  // Terminated executions (executor.finished) attributed to the key.
  readonly n: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly usd: number
  // Mean `used` of the context.assembled events of the key; null when there are none.
  readonly contextTokensAvg: number | null
  // ok verdicts / n; null when n is 0.
  readonly okRate: number | null
}

export interface CostTotals {
  readonly n: number
  readonly tokensIn: number
  readonly okRate: number | null
}

// tokensInPct: relative change of tokensIn per execution. okRatePct: change in percentage points.
export interface CostDelta {
  readonly tokensInPct: number | null
  readonly okRatePct: number | null
}

export interface CostReport {
  readonly rows: ReadonlyArray<CostRow>
  readonly delta: CostDelta
}

const UNKNOWN_EXECUTOR = "unknown"
const UNKNOWN_TIER = "unknown"

interface Execution {
  readonly taskId: string
  readonly botId: string
  readonly executor: string
  readonly ok: boolean
  readonly at: number
}

interface Spend {
  readonly taskId: string
  readonly botId: string
  readonly executor: string
  readonly usage: Usage
  readonly at: number
}

interface ContextSize {
  readonly taskId: string
  readonly used: number
  readonly at: number
}

// Everything a report needs, extracted once from the log.
interface Attribution {
  readonly executions: ReadonlyArray<Execution>
  readonly spends: ReadonlyArray<Spend>
  readonly contexts: ReadonlyArray<ContextSize>
  readonly taskBot: ReadonlyMap<string, string>
  readonly taskExecutor: ReadonlyMap<string, string>
  readonly taskTier: ReadonlyMap<string, string>
}

const stepKey = (taskId: string, stepId: string | undefined): string => `${taskId}|${stepId ?? ""}`

// Pass the events in log order. An execution's executor is the one its executor.started named for the same task and
// step; without that, the last executor the task showed before it (started or usage); without either, "unknown".
const attribute = (events: ReadonlyArray<Event>): Attribution => {
  const startedByStep = new Map<string, string>()
  const executorByTask = new Map<string, string>()
  const taskBot = new Map<string, string>()
  const executions: Array<Execution> = []
  const spends: Array<Spend> = []
  const contexts: Array<ContextSize> = []
  const taskTier = new Map<string, string>()
  for (const event of events) {
    const at = DateTime.toEpochMillis(event.occurredAt)
    if (event.type === "task.received") {
      const payload = Option.getOrUndefined(decodeTaskReceived(event.payload))
      if (payload !== undefined) taskTier.set(payload.task.id, payload.task.tier)
    } else if (event.type === "executor.started") {
      const payload = Option.getOrUndefined(decodeExecutorStarted(event.payload))
      if (payload === undefined) continue
      startedByStep.set(stepKey(payload.taskId, payload.stepId), payload.executor)
      executorByTask.set(payload.taskId, payload.executor)
      taskBot.set(payload.taskId, payload.botId)
    } else if (event.type === "executor.finished") {
      const payload = Option.getOrUndefined(decodeExecutorFinished(event.payload))
      if (payload === undefined) continue
      taskBot.set(payload.taskId, payload.botId)
      const executor =
        startedByStep.get(stepKey(payload.taskId, payload.stepId)) ??
        executorByTask.get(payload.taskId) ??
        UNKNOWN_EXECUTOR
      executions.push({
        taskId: payload.taskId,
        botId: payload.botId,
        executor,
        ok: payload.verdict.kind === "ok",
        at,
      })
    } else if (event.type === "usage.recorded") {
      const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
      if (payload === undefined) continue
      taskBot.set(payload.taskId, payload.botId)
      executorByTask.set(payload.taskId, payload.executor)
      spends.push({
        taskId: payload.taskId,
        botId: payload.botId,
        executor: payload.executor,
        usage: payload.usage,
        at,
      })
    } else if (event.type === "context.assembled") {
      const payload = Option.getOrUndefined(decodeContextAssembled(event.payload))
      if (payload === undefined) continue
      contexts.push({ taskId: payload.taskId, used: payload.used, at })
    }
  }
  return { executions, spends, contexts, taskBot, taskExecutor: executorByTask, taskTier }
}

const inWindow = (at: number, window: CostWindow): boolean => at >= window.since && at < window.until

const groupKey = (by: CostBy, taskId: string, botId: string, executor: string, tier: string): string => {
  switch (by) {
    case "task":
      return taskId
    case "bot":
      return botId
    case "executor":
      return executor
    case "tier":
      return tier
  }
}

const totalsFor = (a: Attribution, window: CostWindow): CostTotals => {
  let n = 0
  let ok = 0
  let tokensIn = 0
  for (const execution of a.executions) {
    if (!inWindow(execution.at, window)) continue
    n += 1
    if (execution.ok) ok += 1
  }
  for (const spend of a.spends) {
    if (inWindow(spend.at, window)) tokensIn += spend.usage.tokensIn
  }
  return { n, tokensIn, okRate: n === 0 ? null : ok / n }
}

interface Accumulator {
  n: number
  ok: number
  tokensIn: number
  tokensOut: number
  usd: number
  contextSum: number
  contextCount: number
}

const rowsFor = (a: Attribution, window: CostWindow, by: CostBy): ReadonlyArray<CostRow> => {
  const slots = new Map<string, Accumulator>()
  const slot = (key: string): Accumulator => {
    const existing = slots.get(key)
    if (existing !== undefined) return existing
    const created: Accumulator = {
      n: 0,
      ok: 0,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      contextSum: 0,
      contextCount: 0,
    }
    slots.set(key, created)
    return created
  }
  const tierOf = (taskId: string): string => a.taskTier.get(taskId) ?? UNKNOWN_TIER
  for (const execution of a.executions) {
    if (!inWindow(execution.at, window)) continue
    const s = slot(
      groupKey(by, execution.taskId, execution.botId, execution.executor, tierOf(execution.taskId)),
    )
    s.n += 1
    if (execution.ok) s.ok += 1
  }
  for (const spend of a.spends) {
    if (!inWindow(spend.at, window)) continue
    const s = slot(groupKey(by, spend.taskId, spend.botId, spend.executor, tierOf(spend.taskId)))
    s.tokensIn += spend.usage.tokensIn
    s.tokensOut += spend.usage.tokensOut
    s.usd += spend.usage.usd
  }
  for (const context of a.contexts) {
    if (!inWindow(context.at, window)) continue
    const key =
      by === "task"
        ? context.taskId
        : by === "bot"
          ? a.taskBot.get(context.taskId)
          : by === "executor"
            ? a.taskExecutor.get(context.taskId)
            : tierOf(context.taskId)
    if (key === undefined) continue
    const s = slot(key)
    s.contextSum += context.used
    s.contextCount += 1
  }
  return Array.from(
    slots,
    ([key, s]): CostRow => ({
      key,
      n: s.n,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      usd: s.usd,
      contextTokensAvg: s.contextCount === 0 ? null : s.contextSum / s.contextCount,
      okRate: s.n === 0 ? null : s.ok / s.n,
    }),
  ).sort((x, y) => y.usd - x.usd || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
}

// Null when there is no baseline, no execution on either side, or a zero baseline (no division by zero).
export const costDelta = (current: CostTotals, baseline: CostTotals | undefined): CostDelta => {
  if (baseline === undefined) return { tokensInPct: null, okRatePct: null }
  const perExecution = (totals: CostTotals): number | null =>
    totals.n === 0 ? null : totals.tokensIn / totals.n
  const currentPerExecution = perExecution(current)
  const baselinePerExecution = perExecution(baseline)
  const tokensInPct =
    currentPerExecution === null || baselinePerExecution === null || baselinePerExecution === 0
      ? null
      : ((currentPerExecution - baselinePerExecution) / baselinePerExecution) * 100
  const okRatePct =
    current.okRate === null || baseline.okRate === null ? null : (current.okRate - baseline.okRate) * 100
  return { tokensInPct, okRatePct }
}

// Rows of `current` grouped by `by`, plus the delta against `baseline` when one is given.
export const costReport = (
  events: ReadonlyArray<Event>,
  windows: { readonly current: CostWindow; readonly baseline?: CostWindow | undefined },
  by: CostBy,
): CostReport => {
  const a = attribute(events)
  const baseline = windows.baseline === undefined ? undefined : totalsFor(a, windows.baseline)
  return {
    rows: rowsFor(a, windows.current, by),
    delta: costDelta(totalsFor(a, windows.current), baseline),
  }
}

export const readCostEvents = (): Effect.Effect<ReadonlyArray<Event>, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* Stream.runCollect(beacon.readAll(0, COST_EVENT_TYPES))
  })
