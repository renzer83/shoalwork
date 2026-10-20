import { Schema } from "effect"
import { Risk } from "./enums.js"
import { ToolCall } from "./executor.js"
import { ApprovalId, BotId, TaskId } from "./ids.js"

// Evaluation order deny → ask → allow is the policy's job (02-architecture §7), not the schema's.
export const PolicyEffect = Schema.Literals(["allow", "ask", "deny"])
export type PolicyEffect = typeof PolicyEffect.Type

export const PolicyRule = Schema.Struct({
  bot: Schema.Union([BotId, Schema.Literal("*")]),
  tool: Schema.String,
  // Glob over the tool resource; matching is done by the policy engine.
  resource: Schema.optional(Schema.String),
  effect: PolicyEffect,
  reason: Schema.optional(Schema.String),
})
export type PolicyRule = typeof PolicyRule.Type

export const PolicyDecision = Schema.Struct({
  effect: PolicyEffect,
  rule: Schema.optional(PolicyRule),
  risk: Risk,
})
export type PolicyDecision = typeof PolicyDecision.Type

export const ApprovalStatus = Schema.Literals(["pending", "approved", "denied", "expired"])
export type ApprovalStatus = typeof ApprovalStatus.Type

// inline: the CLI is blocked on the tool call until the decision (permission bridge, T-055). resume: the run ended and
// the Lead continues the session once decided (T-054).
export const ApprovalMode = Schema.Literals(["inline", "resume"])
export type ApprovalMode = typeof ApprovalMode.Type

// expiresAt < requestedAt is accepted here; the temporal rule belongs to the policy engine.
export const Approval = Schema.Struct({
  id: ApprovalId,
  taskId: TaskId,
  botId: BotId,
  action: ToolCall,
  risk: Risk,
  status: ApprovalStatus,
  requestedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  resolvedAt: Schema.optional(Schema.DateTimeUtcFromString),
  resolvedBy: Schema.optional(Schema.String),
})
export type Approval = typeof Approval.Type
