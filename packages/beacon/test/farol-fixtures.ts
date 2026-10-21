import { BotId, Event, type EventType, streamIds, TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"

export const TASK_1 = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
export const TASK_2 = Schema.decodeUnknownSync(TaskId)("task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
export const TASK_3 = Schema.decodeUnknownSync(TaskId)("task_2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f")
export const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")

let counter = 0

// Built through the Event schema, so the fixture is checked the way the log is. Positions follow build order.
export const stored = (type: EventType, taskId: TaskId, payload: unknown, occurredAt: string): Event => {
  counter += 1
  return Schema.decodeUnknownSync(Event)({
    id: `evt_00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    streamId: streamIds.task(taskId),
    version: counter,
    position: counter,
    type,
    payload,
    actor: "system:test",
    correlationId: "corr_farol",
    occurredAt,
  })
}

export const usage = (tokensIn: number, usd: number) => ({
  tokensIn,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
  seconds: 1,
})

export const usageEvent = (taskId: TaskId, model: string, tokensIn: number, usd: number, at: string): Event =>
  stored(
    "usage.recorded",
    taskId,
    { taskId, botId: BOT, executor: "claude-code", model, usage: usage(tokensIn, usd) },
    at,
  )

export const decisionEvent = (taskId: TaskId, source: "rule" | "model" | "cache", at: string): Event =>
  stored(
    "decision.made",
    taskId,
    {
      decisionId: `dec_${counter}`,
      questionId: "q_route",
      kind: "choice",
      value: "a",
      confidence: 0.9,
      source,
      facts: {},
    },
    at,
  )

export const finishedEvent = (taskId: TaskId, at: string): Event =>
  stored(
    "executor.finished",
    taskId,
    {
      taskId,
      botId: BOT,
      verdict: {
        kind: "ok",
        summary: "s",
        evidence: [],
        cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
      },
      durationMs: 1000,
    },
    at,
  )

export const contextEvent = (
  taskId: TaskId,
  dropped: ReadonlyArray<{ block: string; items: number }>,
  compaction: ReadonlyArray<{ block: string; level: number; before: number; after: number }>,
  at: string,
): Event =>
  stored(
    "context.assembled",
    taskId,
    {
      taskId,
      level: "full",
      used: 100,
      budget: 2000,
      dropped,
      ...(compaction.length === 0 ? {} : { compaction }),
    },
    at,
  )

export const receivedEvent = (
  taskId: TaskId,
  tier: "chat" | "decision" | "light" | "heavy",
  at: string,
): Event =>
  stored(
    "task.received",
    taskId,
    {
      task: {
        id: taskId,
        botId: BOT,
        title: "t",
        prompt: "p",
        kind: "code",
        acceptance: [],
        budget: { tokens: 1, seconds: 1, usd: 1 },
        tier,
        origin: "cli",
      },
    },
    at,
  )
