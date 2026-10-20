import { Schema } from "effect"
import { Risk } from "../enums.js"
import { ToolCall } from "../executor.js"
import { ApprovalId, BotId, TaskId } from "../ids.js"

export const ApprovalRequestedPayload = Schema.Struct({
  approvalId: ApprovalId,
  taskId: TaskId,
  botId: BotId,
  action: ToolCall,
  risk: Risk,
  expiresAt: Schema.DateTimeUtcFromString,
})

export const ApprovalResolvedPayload = Schema.Struct({
  approvalId: ApprovalId,
  decision: Schema.Literals(["approved", "denied", "expired"]),
  by: Schema.String,
})

export const PolicyDeniedPayload = Schema.Struct({
  botId: BotId,
  taskId: Schema.optional(TaskId),
  tool: Schema.String,
  resource: Schema.optional(Schema.String),
  rule: Schema.String,
})
