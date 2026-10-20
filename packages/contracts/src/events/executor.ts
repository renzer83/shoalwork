import { Schema } from "effect"
import { Usage } from "../budget.js"
import { ExecutorEvent, PermissionMode } from "../executor.js"
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
  // Audit of the run's permissions (T-057): derived from the Bot's policy. Optional so that events written before
  // T-057 still decode (resume and cost reports read this payload).
  permissionMode: Schema.optional(PermissionMode),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
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
