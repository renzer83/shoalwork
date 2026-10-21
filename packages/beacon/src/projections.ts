import {
  addUsage,
  type BotId,
  type BotState,
  type Event,
  EventPayloads,
  type EventType,
  streamIds,
  type TaskId,
  type TaskState,
  type Usage,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { Beacon } from "./beacon.js"
import type { CostWindow } from "./cost-report.js"

export * from "./context-metrics.js"

// Projections are derived from the log, never stored as truth (02-architecture §1). Payloads that do not
// match their schema are skipped: the log was validated on write, so a skip here means a foreign row.
const decodeTaskStateChanged = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const decodeBotStateChanged = Schema.decodeUnknownOption(EventPayloads["bot.state_changed"])
const decodeUsageRecorded = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])
const decodeDecisionMade = Schema.decodeUnknownOption(EventPayloads["decision.made"])
const decodeContextAssembled = Schema.decodeUnknownOption(EventPayloads["context.assembled"])
const decodeExecutorFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])

// Last `task.state_changed.to` in the given events. Pass the events of one task stream.
export const taskState = (events: ReadonlyArray<Event>): TaskState | undefined => {
  let state: TaskState | undefined
  for (const event of events) {
    if (event.type !== "task.state_changed") continue
    const payload = Option.getOrUndefined(decodeTaskStateChanged(event.payload))
    if (payload !== undefined) state = payload.to
  }
  return state
}

// Last `bot.state_changed.to` in the given events. Pass the events of one bot stream.
export const botState = (events: ReadonlyArray<Event>): BotState | undefined => {
  let state: BotState | undefined
  for (const event of events) {
    if (event.type !== "bot.state_changed") continue
    const payload = Option.getOrUndefined(decodeBotStateChanged(event.payload))
    if (payload !== undefined) state = payload.to
  }
  return state
}

export const costByTask = (events: ReadonlyArray<Event>): Map<TaskId, Usage> => {
  const totals = new Map<TaskId, Usage>()
  for (const event of events) {
    if (event.type !== "usage.recorded") continue
    const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
    if (payload === undefined) continue
    totals.set(payload.taskId, addUsage(totals.get(payload.taskId) ?? ZERO_USAGE, payload.usage))
  }
  return totals
}

export const costByBot = (events: ReadonlyArray<Event>): Map<BotId, Usage> => {
  const totals = new Map<BotId, Usage>()
  for (const event of events) {
    if (event.type !== "usage.recorded") continue
    const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
    if (payload === undefined) continue
    totals.set(payload.botId, addUsage(totals.get(payload.botId) ?? ZERO_USAGE, payload.usage))
  }
  return totals
}

// Usage a Bot recorded at or after `sinceMs` (epoch ms): the rolling window of its budget. Pass the events of usage.recorded.
export const usageForBotSince = (events: ReadonlyArray<Event>, botId: BotId, sinceMs: number): Usage => {
  let total: Usage = ZERO_USAGE
  for (const event of events) {
    if (event.type !== "usage.recorded" || DateTime.toEpochMillis(event.occurredAt) < sinceMs) continue
    const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
    if (payload === undefined || payload.botId !== botId) continue
    total = addUsage(total, payload.usage)
  }
  return total
}

// Per stream id, the event with the highest log position.
export const latestPerStream = (events: ReadonlyArray<Event>): Map<string, Event> => {
  const latest = new Map<string, Event>()
  for (const event of events) {
    const current = latest.get(event.streamId)
    if (current === undefined || event.position > current.position) {
      latest.set(event.streamId, event)
    }
  }
  return latest
}

// Effectful versions: read the stream (or the log) through Beacon, then apply the pure projection.
export const readTaskState = (taskId: TaskId): Effect.Effect<TaskState | undefined, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(taskId)))
    return taskState(events)
  })

export const readBotState = (botId: BotId): Effect.Effect<BotState | undefined, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readStream(streamIds.bot(botId)))
    return botState(events)
  })

export const readCostByTask = (): Effect.Effect<Map<TaskId, Usage>, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readAll(0, ["usage.recorded"]))
    return costByTask(events)
  })

export const readCostByBot = (): Effect.Effect<Map<BotId, Usage>, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readAll(0, ["usage.recorded"]))
    return costByBot(events)
  })

export const readUsageForBotSince = (botId: BotId, sinceMs: number): Effect.Effect<Usage, SqlError, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readAll(0, ["usage.recorded"]))
    return usageForBotSince(events, botId, sinceMs)
  })

// Farol read-models (T-121). Both are pure over events already windowed by Beacon.readRange with these types.
export const SAVINGS_EVENT_TYPES: ReadonlyArray<EventType> = [
  "decision.made",
  "usage.recorded",
  "context.assembled",
]
export const DAILY_COST_EVENT_TYPES: ReadonlyArray<EventType> = ["executor.finished", "usage.recorded"]

export interface SavingsReport {
  readonly decisions: {
    readonly total: number
    // rule and cache answered without a model call; model asked one.
    readonly rule: number
    readonly cache: number
    readonly model: number
    // (rule + cache) / total in percent; null when there are no decisions.
    readonly localPct: number | null
  }
  // Runs on a Haiku model in the window, and their mean usd: the estimate of what one decision costs a model.
  readonly haikuRuns: number
  readonly decisionUsd: number | null
  // (rule + cache) decisions x decisionUsd: what the model calls that were not made would have cost.
  readonly avoidedUsd: number | null
  readonly context: {
    readonly assembled: number
    // Tokens of the blocks that compaction shortened, before and after it.
    readonly tokensBefore: number
    readonly tokensAfter: number
    readonly tokensCut: number
    // tokensCut / tokensBefore in percent; null when no block was compacted.
    readonly cutPct: number | null
    // Items the budget dropped. The payload carries counts only, so these have no tokens and no usd.
    readonly droppedItems: number
    // usd per input token over every usage.recorded of the window (blended across models); null without input tokens.
    readonly usdPerInputToken: number | null
    readonly avoidedUsd: number | null
  }
}

const HAIKU_MODEL = /haiku/i

const percentOf = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100)

const inCostWindow = (at: number, window: CostWindow): boolean => at >= window.since && at < window.until

// Savings of the window: the local decisions and the context compaction, valued in usd from what the log measured.
export const savings = (events: ReadonlyArray<Event>, window: CostWindow): SavingsReport => {
  const counts = { rule: 0, cache: 0, model: 0 }
  let tokensIn = 0
  let usd = 0
  let haikuRuns = 0
  let haikuUsd = 0
  let assembled = 0
  let tokensBefore = 0
  let tokensAfter = 0
  let droppedItems = 0
  for (const event of events) {
    if (!inCostWindow(DateTime.toEpochMillis(event.occurredAt), window)) continue
    if (event.type === "decision.made") {
      const payload = Option.getOrUndefined(decodeDecisionMade(event.payload))
      if (payload !== undefined) counts[payload.source] += 1
    } else if (event.type === "usage.recorded") {
      const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
      if (payload === undefined) continue
      tokensIn += payload.usage.tokensIn
      usd += payload.usage.usd
      if (HAIKU_MODEL.test(payload.model)) {
        haikuRuns += 1
        haikuUsd += payload.usage.usd
      }
    } else if (event.type === "context.assembled") {
      const payload = Option.getOrUndefined(decodeContextAssembled(event.payload))
      if (payload === undefined) continue
      assembled += 1
      for (const dropped of payload.dropped) droppedItems += dropped.items
      for (const entry of payload.compaction ?? []) {
        tokensBefore += entry.before
        tokensAfter += entry.after
      }
    }
  }
  const total = counts.rule + counts.cache + counts.model
  const local = counts.rule + counts.cache
  const decisionUsd = haikuRuns === 0 ? null : haikuUsd / haikuRuns
  const tokensCut = tokensBefore - tokensAfter
  const usdPerInputToken = tokensIn === 0 ? null : usd / tokensIn
  return {
    decisions: {
      total,
      rule: counts.rule,
      cache: counts.cache,
      model: counts.model,
      localPct: percentOf(local, total),
    },
    haikuRuns,
    decisionUsd,
    avoidedUsd: decisionUsd === null ? null : local * decisionUsd,
    context: {
      assembled,
      tokensBefore,
      tokensAfter,
      tokensCut,
      cutPct: percentOf(tokensCut, tokensBefore),
      droppedItems,
      usdPerInputToken,
      avoidedUsd: usdPerInputToken === null ? null : tokensCut * usdPerInputToken,
    },
  }
}

export interface DailyCost {
  // UTC day, YYYY-MM-DD.
  readonly day: string
  // executor.finished in the day.
  readonly n: number
  readonly usd: number
}

const DAY_MS = 86_400_000
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

// One row per UTC day from the day of `since` up to `until`, zero-filled, oldest first. The caller bounds the window.
export const dailyCost = (events: ReadonlyArray<Event>, window: CostWindow): ReadonlyArray<DailyCost> => {
  const days = new Map<string, { n: number; usd: number }>()
  for (let at = Math.floor(window.since / DAY_MS) * DAY_MS; at < window.until; at += DAY_MS) {
    days.set(dayOf(at), { n: 0, usd: 0 })
  }
  for (const event of events) {
    const at = DateTime.toEpochMillis(event.occurredAt)
    if (!inCostWindow(at, window)) continue
    const slot = days.get(dayOf(at))
    if (slot === undefined) continue
    if (event.type === "executor.finished" && Option.isSome(decodeExecutorFinished(event.payload))) {
      slot.n += 1
    } else if (event.type === "usage.recorded") {
      const payload = Option.getOrUndefined(decodeUsageRecorded(event.payload))
      if (payload !== undefined) slot.usd += payload.usage.usd
    }
  }
  return Array.from(days, ([day, slot]): DailyCost => ({ day, n: slot.n, usd: slot.usd }))
}
