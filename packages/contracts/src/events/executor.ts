import { Schema } from "effect"
import { Usage } from "../budget.js"
import { ExecutorEvent } from "../executor.js"
import { BotId, ExecutorId, SessionId, StepId, TaskId } from "../ids.js"
import { Verdict } from "../verdict.js"

export const ExecutorStartedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  executor: ExecutorId,
  model: Schema.String,
  sessionId: Schema.optional(SessionId),
  cwd: Schema.String,
})

export const ExecutorEventPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  event: ExecutorEvent,
})

export const ExecutorFinishedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  verdict: Verdict,
  sessionId: Schema.optional(SessionId),
  durationMs: Schema.Int,
})

export const UsageRecordedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  executor: ExecutorId,
  model: Schema.String,
  usage: Usage,
})
