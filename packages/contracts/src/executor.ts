import { Schema } from "effect"
import { Budget, Usage } from "./budget.js"
import { ModelTier, Risk } from "./enums.js"
import type { ExecutorProtocolError, ExecutorSpawnError } from "./errors.js"
import { BotId, ExecutorId, SessionId, StepId, TaskId } from "./ids.js"
import { Artifact } from "./task.js"

// Abstract permission level; each adapter maps it to its CLI flags (02-architecture §5).
export const PermissionMode = Schema.Literals(["readonly", "edit", "auto", "bypass"])
export type PermissionMode = typeof PermissionMode.Type

export const ToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  resource: Schema.optional(Schema.String),
})
export type ToolCall = typeof ToolCall.Type

export const ExecutorTask = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  prompt: Schema.String,
  systemAppend: Schema.optional(Schema.String),
  tier: ModelTier,
  allowedTools: Schema.Array(Schema.String),
  permissionMode: PermissionMode,
  maxTurns: Schema.Int,
  budget: Budget,
  resumeSessionId: Schema.optional(SessionId),
})
export type ExecutorTask = typeof ExecutorTask.Type

export const ToolCallStatus = Schema.Literals(["started", "completed", "failed"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const ExecutorErrorCode = Schema.Literals([
  "max_turns",
  "budget",
  "protocol",
  "spawn",
  "auth",
  "unknown",
])
export type ExecutorErrorCode = typeof ExecutorErrorCode.Type

export const ExecutorEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("started"),
    sessionId: Schema.optional(SessionId),
    model: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("thinking"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("file_edit"),
    path: Schema.String,
    diff: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    cmd: Schema.String,
    exitCode: Schema.optional(Schema.Int),
    output: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("tool_call"), call: ToolCall, status: ToolCallStatus }),
  Schema.Struct({ kind: Schema.Literal("approval_needed"), action: ToolCall, risk: Risk }),
  Schema.Struct({ kind: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({
    kind: Schema.Literal("done"),
    result: Schema.String,
    artifacts: Schema.Array(Artifact),
    sessionId: Schema.optional(SessionId),
  }),
  Schema.Struct({ kind: Schema.Literal("error"), code: ExecutorErrorCode, message: Schema.String }),
])
export type ExecutorEvent = typeof ExecutorEvent.Type

// Adapter failures (both already tagged in errors.ts).
export type ExecutorError = ExecutorSpawnError | ExecutorProtocolError

// Fraction of the executor window already used; 0..1 per the contract.
export const QuotaStatus = Schema.Struct({
  executor: ExecutorId,
  windowEndsAt: Schema.optional(Schema.DateTimeUtcFromString),
  usedRatio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  available: Schema.Boolean,
})
export type QuotaStatus = typeof QuotaStatus.Type
