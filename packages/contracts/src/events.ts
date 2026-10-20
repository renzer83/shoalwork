import { Effect, Schema } from "effect"
import { Bot } from "./bot.js"
import { Budget, Usage } from "./budget.js"
import { BotState, Risk, TaskState } from "./enums.js"
import { SchemaViolation } from "./errors.js"
import { ExecutorEvent, ToolCall } from "./executor.js"
import { ApprovalId, BotId, EventId, ExecutorId, PlanId, SessionId, StepId, TaskId, TideId } from "./ids.js"
import { TaskSpec } from "./task.js"
import { Verdict } from "./verdict.js"

// Closed list: adding a type is a spec change (02-architecture §3).
export const EventType = Schema.Literals([
  "task.received",
  "task.planned",
  "task.state_changed",
  "decision.made",
  "decision.outcome",
  "bot.created",
  "bot.state_changed",
  "executor.started",
  "executor.event",
  "executor.finished",
  "usage.recorded",
  "approval.requested",
  "approval.resolved",
  "policy.denied",
  "message.inbound",
  "message.outbound",
  "tide.fired",
  "watchdog.recovered",
  "budget.exceeded",
  "error.raised",
])
export type EventType = typeof EventType.Type

const Channel = Schema.Literals(["telegram", "api", "cli"])

const TaskReceivedPayload = Schema.Struct({ task: TaskSpec })

const TaskPlannedPayload = Schema.Struct({
  taskId: TaskId,
  planId: PlanId,
  stepCount: Schema.Int,
})

const TaskStateChangedPayload = Schema.Struct({
  taskId: TaskId,
  from: TaskState,
  to: TaskState,
  reason: Schema.optional(Schema.String),
})

const DecisionMadePayload = Schema.Struct({
  decisionId: Schema.String,
  questionId: Schema.String,
  kind: Schema.Literals(["noul", "choice", "score"]),
  value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]),
  confidence: Schema.Number,
  source: Schema.Literals(["rule", "model", "cache"]),
  facts: Schema.Record(Schema.String, Schema.Unknown),
})

const DecisionOutcomePayload = Schema.Struct({
  decisionId: Schema.String,
  outcome: Schema.Literals(["correct", "corrected_by_human", "escalated", "unknown"]),
  note: Schema.optional(Schema.String),
})

const BotCreatedPayload = Schema.Struct({
  bot: Bot,
  by: Schema.String,
})

const BotStateChangedPayload = Schema.Struct({
  botId: BotId,
  from: BotState,
  to: BotState,
  taskId: Schema.optional(TaskId),
})

const ExecutorStartedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  executor: ExecutorId,
  model: Schema.String,
  sessionId: Schema.optional(SessionId),
  cwd: Schema.String,
})

const ExecutorEventPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  event: ExecutorEvent,
})

const ExecutorFinishedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  verdict: Verdict,
  sessionId: Schema.optional(SessionId),
  durationMs: Schema.Int,
})

const UsageRecordedPayload = Schema.Struct({
  taskId: TaskId,
  stepId: Schema.optional(StepId),
  botId: BotId,
  executor: ExecutorId,
  model: Schema.String,
  usage: Usage,
})

const ApprovalRequestedPayload = Schema.Struct({
  approvalId: ApprovalId,
  taskId: TaskId,
  botId: BotId,
  action: ToolCall,
  risk: Risk,
  expiresAt: Schema.DateTimeUtcFromString,
})

const ApprovalResolvedPayload = Schema.Struct({
  approvalId: ApprovalId,
  decision: Schema.Literals(["approved", "denied", "expired"]),
  by: Schema.String,
})

const PolicyDeniedPayload = Schema.Struct({
  botId: BotId,
  taskId: Schema.optional(TaskId),
  tool: Schema.String,
  resource: Schema.optional(Schema.String),
  rule: Schema.String,
})

const MessageInboundPayload = Schema.Struct({
  channel: Channel,
  chatId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  userId: Schema.String,
  text: Schema.String,
  botId: Schema.optional(BotId),
})

const MessageOutboundPayload = Schema.Struct({
  channel: Channel,
  chatId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  botId: BotId,
  text: Schema.String,
  latencyMs: Schema.optional(Schema.Int),
  inReplyTo: Schema.optional(EventId),
})

const TideFiredPayload = Schema.Struct({
  tideId: TideId,
  botId: BotId,
  trigger: Schema.Literals(["cron", "event"]),
  taskId: TaskId,
})

const WatchdogRecoveredPayload = Schema.Struct({
  what: Schema.Literals([
    "stale_task",
    "stale_job",
    "long_process",
    "expired_approval",
    "state_mismatch",
    "orphan_worktree",
  ]),
  ref: Schema.String,
  action: Schema.String,
})

const BudgetExceededPayload = Schema.Struct({
  scope: Schema.Literals(["task", "bot", "pod"]),
  refId: Schema.String,
  limit: Budget,
  used: Budget,
})

const ErrorRaisedPayload = Schema.Struct({
  where: Schema.String,
  tag: Schema.String,
  message: Schema.String,
  taskId: Schema.optional(TaskId),
  botId: Schema.optional(BotId),
})

// One payload schema per event type; `satisfies` keeps the map exhaustive.
export const EventPayloads = {
  "task.received": TaskReceivedPayload,
  "task.planned": TaskPlannedPayload,
  "task.state_changed": TaskStateChangedPayload,
  "decision.made": DecisionMadePayload,
  "decision.outcome": DecisionOutcomePayload,
  "bot.created": BotCreatedPayload,
  "bot.state_changed": BotStateChangedPayload,
  "executor.started": ExecutorStartedPayload,
  "executor.event": ExecutorEventPayload,
  "executor.finished": ExecutorFinishedPayload,
  "usage.recorded": UsageRecordedPayload,
  "approval.requested": ApprovalRequestedPayload,
  "approval.resolved": ApprovalResolvedPayload,
  "policy.denied": PolicyDeniedPayload,
  "message.inbound": MessageInboundPayload,
  "message.outbound": MessageOutboundPayload,
  "tide.fired": TideFiredPayload,
  "watchdog.recovered": WatchdogRecoveredPayload,
  "budget.exceeded": BudgetExceededPayload,
  "error.raised": ErrorRaisedPayload,
} satisfies Record<EventType, Schema.Top>

// Input shape for appending: the core assigns id, version, position and occurredAt.
export const NewEvent = Schema.Struct({
  streamId: Schema.String,
  type: EventType,
  payload: Schema.Unknown,
  actor: Schema.String,
  correlationId: Schema.String,
  causationId: Schema.optional(EventId),
})
export type NewEvent = typeof NewEvent.Type

export const Event = Schema.Struct({
  ...NewEvent.fields,
  id: EventId,
  version: Schema.Int,
  position: Schema.Int,
  occurredAt: Schema.DateTimeUtcFromString,
})
export type Event = typeof Event.Type

// Envelope failures use where = "event"; payload failures use where = "payload:<type>".
// The stored payload is the encoded form: JSON-safe, with defaults applied and extra keys dropped.
export const decodeNewEvent = (raw: unknown): Effect.Effect<NewEvent, SchemaViolation> =>
  Effect.gen(function* () {
    const event = yield* Schema.decodeUnknownEffect(NewEvent)(raw).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: "event", issue: e.issue })),
    )
    const decoded = yield* Schema.decodeUnknownEffect(EventPayloads[event.type])(event.payload).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: `payload:${event.type}`, issue: e.issue })),
    )
    const payload = yield* Schema.encodeEffect(EventPayloads[event.type])(decoded).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: `payload:${event.type}`, issue: e.issue })),
    )
    return { ...event, payload }
  })

export const streamIds = {
  bot: (id: BotId) => `bot:${id}`,
  task: (id: TaskId) => `task:${id}`,
  system: "system",
} as const
