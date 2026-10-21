import {
  addUsage,
  type BotId,
  type BotState,
  type Event,
  EventPayloads,
  streamIds,
  type TaskId,
  type TaskState,
  type Usage,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { Beacon } from "./beacon.js"

export * from "./context-metrics.js"

// Projections are derived from the log, never stored as truth (02-architecture §1). Payloads that do not
// match their schema are skipped: the log was validated on write, so a skip here means a foreign row.
const decodeTaskStateChanged = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const decodeBotStateChanged = Schema.decodeUnknownOption(EventPayloads["bot.state_changed"])
const decodeUsageRecorded = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])

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
