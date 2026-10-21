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
