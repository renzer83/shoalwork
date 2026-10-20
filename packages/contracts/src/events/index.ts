import { Effect, Schema } from "effect"
import { SchemaViolation } from "../errors.js"
import { type BotId, EventId, type TaskId } from "../ids.js"
import { ApprovalRequestedPayload, ApprovalResolvedPayload, PolicyDeniedPayload } from "./approval.js"
import {
  BotCreatedPayload,
  BotProposalResolvedPayload,
  BotProposedPayload,
  BotStateChangedPayload,
} from "./bot.js"
import { DecisionMadePayload, DecisionOutcomePayload } from "./decision.js"
import {
  ExecutorEventPayload,
  ExecutorFinishedPayload,
  ExecutorStartedPayload,
  UsageRecordedPayload,
} from "./executor.js"
import {
  GithubCheckSuitePayload,
  GithubIssuesPayload,
  GithubPullRequestPayload,
  GithubPushPayload,
  GithubWorkflowRunPayload,
} from "./github.js"
import { MemoryAddedPayload, MemoryForgottenPayload, MemorySupersededPayload } from "./memory.js"
import { AgentMsgPayload, MessageInboundPayload, MessageOutboundPayload } from "./message.js"
import {
  BudgetExceededPayload,
  ContextAssembledPayload,
  ControlChangedPayload,
  ErrorRaisedPayload,
  WatchdogRecoveredPayload,
} from "./ops.js"
import { PodClosedPayload, PodOpenedPayload } from "./pod.js"
import { TaskPlannedPayload, TaskReceivedPayload, TaskStateChangedPayload } from "./task.js"
import { TideFiredPayload, TideSkippedPayload } from "./tide.js"
import { ReviewDecidedPayload, StepVerifiedPayload } from "./verify.js"

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
  "tide.skipped",
  "watchdog.recovered",
  "budget.exceeded",
  "error.raised",
  "memory.added",
  "memory.superseded",
  "memory.forgotten",
  "control.changed",
  "bot.proposed",
  "bot.proposal_resolved",
  "context.assembled",
  "agent.msg",
  "github.issues",
  "github.pull_request",
  "github.workflow_run",
  "github.check_suite",
  "github.push",
  "pod.opened",
  "pod.closed",
  "step.verified",
  "review.decided",
])
export type EventType = typeof EventType.Type

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
  "tide.skipped": TideSkippedPayload,
  "watchdog.recovered": WatchdogRecoveredPayload,
  "budget.exceeded": BudgetExceededPayload,
  "error.raised": ErrorRaisedPayload,
  "memory.added": MemoryAddedPayload,
  "memory.superseded": MemorySupersededPayload,
  "memory.forgotten": MemoryForgottenPayload,
  "control.changed": ControlChangedPayload,
  "bot.proposed": BotProposedPayload,
  "bot.proposal_resolved": BotProposalResolvedPayload,
  "context.assembled": ContextAssembledPayload,
  "agent.msg": AgentMsgPayload,
  "github.issues": GithubIssuesPayload,
  "github.pull_request": GithubPullRequestPayload,
  "github.workflow_run": GithubWorkflowRunPayload,
  "github.check_suite": GithubCheckSuitePayload,
  "github.push": GithubPushPayload,
  "pod.opened": PodOpenedPayload,
  "pod.closed": PodClosedPayload,
  "step.verified": StepVerifiedPayload,
  "review.decided": ReviewDecidedPayload,
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
