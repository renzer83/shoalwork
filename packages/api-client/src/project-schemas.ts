import { ProjectTaskState } from "@shoalwork/contracts"
import { Schema } from "effect"

// Response shapes of the board, its sprints and the factory metrics (02-architecture §15).

export const SprintView = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  name: Schema.String,
  startsAt: Schema.String,
  endsAt: Schema.String,
  goal: Schema.String,
})
export type SprintView = typeof SprintView.Type
export const SprintList = Schema.Struct({ sprints: Schema.Array(SprintView) })
export const SprintOne = Schema.Struct({ sprint: SprintView })

export const BoardTask = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  title: Schema.String,
  issueNumber: Schema.NullOr(Schema.Number),
  prNumber: Schema.NullOr(Schema.Number),
  state: ProjectTaskState,
  branch: Schema.NullOr(Schema.String),
  retries: Schema.Number,
  manualInterventions: Schema.Number,
  version: Schema.Number,
  updatedAt: Schema.NullOr(Schema.String),
  sprintId: Schema.NullOr(Schema.String),
})
export type BoardTask = typeof BoardTask.Type
export const BoardTaskList = Schema.Struct({ tasks: Schema.Array(BoardTask) })
export const BoardTaskOne = Schema.Struct({ task: BoardTask })

export const GoalRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  target: Schema.String,
  current: Schema.NullOr(Schema.Number),
  baseline: Schema.NullOr(Schema.Number),
  met: Schema.NullOr(Schema.Boolean),
})
export type GoalRow = typeof GoalRow.Type
export const MetricsCompare = Schema.Struct({
  project: Schema.String,
  baselineAt: Schema.NullOr(Schema.String),
  rows: Schema.Array(GoalRow),
})
export type MetricsCompare = typeof MetricsCompare.Type
