import { Schema } from "effect"

// The state of one task of a project on the board (T-060). Closed list: an unknown state is a schema error.
// The state machine that says which transition is legal lives in packages/factory/src/kanban.ts.
export const ProjectTaskState = Schema.Literals([
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "testing",
  "merging",
  "done",
  "blocked",
  "cancelled",
])
export type ProjectTaskState = typeof ProjectTaskState.Type

// Every transition of the board is one event: the log is the truth and `project_tasks` is its projection.
export const ProjectTaskStateChangedPayload = Schema.Struct({
  project: Schema.String,
  taskId: Schema.String,
  from: ProjectTaskState,
  to: ProjectTaskState,
  reason: Schema.optional(Schema.String),
})
export type ProjectTaskStateChangedPayload = typeof ProjectTaskStateChangedPayload.Type

// A sprint of a project is created (T-115): a named time box, dates as ISO-8601 instants.
export const SprintCreatedPayload = Schema.Struct({
  project: Schema.String,
  sprintId: Schema.String,
  name: Schema.String,
  startsAt: Schema.String,
  endsAt: Schema.String,
  goal: Schema.String,
})
export type SprintCreatedPayload = typeof SprintCreatedPayload.Type

// A task moves into or out of a sprint (`null` = no sprint). Not a state change: the task keeps its version.
export const ProjectTaskSprintChangedPayload = Schema.Struct({
  project: Schema.String,
  taskId: Schema.String,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
})
export type ProjectTaskSprintChangedPayload = typeof ProjectTaskSprintChangedPayload.Type
