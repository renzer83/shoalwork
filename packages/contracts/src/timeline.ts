import { Schema } from "effect"
import { Risk, TaskState, VerdictKind } from "./enums.js"
import { Channel } from "./events/message.js"
import { ApprovalId, BotId, EventId, TaskId } from "./ids.js"
import { ApprovalStatus } from "./policy.js"
import { ArtifactKind } from "./task.js"

// One entry of a Bot's conversation as the apps show it (GET /messages, T-113). Built by the core from the Beacon;
// every text field is untrusted data and is rendered as plain text. `position` is the Beacon position of the event.
const at = {
  position: Schema.Int,
  occurredAt: Schema.DateTimeUtcFromString,
}

export const TimelineMessage = Schema.Struct({
  kind: Schema.Literal("message"),
  ...at,
  eventId: EventId,
  direction: Schema.Literals(["in", "out"]),
  channel: Channel,
  text: Schema.String,
})

// Progress of a task: a state change, a command, an edited file or the end of a run. `text` is a bounded summary line.
export const TimelineEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  ...at,
  name: Schema.Literals(["task_state", "command", "file_edit", "finished"]),
  taskId: TaskId,
  text: Schema.String,
  state: Schema.optionalKey(TaskState),
  exitCode: Schema.optionalKey(Schema.Int),
  verdict: Schema.optionalKey(VerdictKind),
})

// An approval card. `status` is the current one (the approvals table), not the one at request time.
export const TimelineApproval = Schema.Struct({
  kind: Schema.Literal("approval"),
  ...at,
  approvalId: ApprovalId,
  taskId: TaskId,
  botId: BotId,
  tool: Schema.String,
  resource: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  risk: Risk,
  expiresAt: Schema.DateTimeUtcFromString,
  status: ApprovalStatus,
  resolvedBy: Schema.optionalKey(Schema.String),
})

export const TimelineArtifact = Schema.Struct({
  kind: Schema.Literal("artifact"),
  ...at,
  taskId: TaskId,
  artifactKind: ArtifactKind,
  ref: Schema.String,
  summary: Schema.optionalKey(Schema.String),
})

export const TimelineItem = Schema.Union([TimelineMessage, TimelineEvent, TimelineApproval, TimelineArtifact])
export type TimelineItem = typeof TimelineItem.Type

// `botId` is the Bot the conversation belongs to (the request may have named it). `items` are oldest first. `nextBefore` is the cursor for the page before this one (null at the start of the
// history); `head` is the newest Beacon position at read time, where the live feed continues from.
export const TimelinePage = Schema.Struct({
  botId: BotId,
  items: Schema.Array(TimelineItem),
  nextBefore: Schema.NullOr(Schema.Int),
  head: Schema.Int,
})
export type TimelinePage = typeof TimelinePage.Type
