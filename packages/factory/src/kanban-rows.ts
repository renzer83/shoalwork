import { ProjectTaskState } from "@shoalwork/contracts"
import { Schema } from "effect"

// The rows of the board and the views the API returns. A state the board does not know (a task imported
// from the bridge with another vocabulary) is read as `backlog`: the machine only knows its own states.
export const ProjectRow = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  repo_url: Schema.String,
  default_branch: Schema.String,
  status: Schema.String,
  max_in_progress: Schema.Int,
  gates: Schema.String,
  e2e: Schema.String,
  auto_merge: Schema.Int,
})
export type ProjectRow = typeof ProjectRow.Type

export const TaskRow = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  title: Schema.String,
  issue_number: Schema.NullOr(Schema.Int),
  pr_number: Schema.NullOr(Schema.Int),
  state: Schema.String,
  retries: Schema.Int,
  manual_interventions: Schema.Int,
  branch: Schema.NullOr(Schema.String),
  version: Schema.Int,
  updated_at: Schema.NullOr(Schema.String),
})
export type TaskRow = typeof TaskRow.Type

export const stateOf = (raw: string): ProjectTaskState => (Schema.is(ProjectTaskState)(raw) ? raw : "backlog")

export interface ProjectView {
  readonly slug: string
  readonly name: string
  readonly repoUrl: string
  readonly defaultBranch: string
  readonly status: string
  readonly maxInProgress: number
  // Commands the worker must pass (acceptance of its task) and the ones the testpilot runs.
  readonly gates: ReadonlyArray<string>
  readonly e2e: ReadonlyArray<string>
  readonly autoMerge: boolean
}

export interface ProjectTaskView {
  readonly id: string
  readonly project: string
  readonly title: string
  readonly issueNumber: number | null
  readonly prNumber: number | null
  readonly state: ProjectTaskState
  readonly branch: string | null
  readonly retries: number
  readonly manualInterventions: number
  readonly version: number
  readonly updatedAt: string | null
}

const decodeCommands = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

// A column that does not hold a JSON array of strings reads as no commands.
export const commandsOf = (raw: string): ReadonlyArray<string> => {
  const decoded = decodeCommands(raw)
  return decoded._tag === "Some" ? decoded.value : []
}

export const projectView = (row: ProjectRow): ProjectView => ({
  slug: row.slug,
  name: row.name,
  repoUrl: row.repo_url,
  defaultBranch: row.default_branch,
  status: row.status,
  maxInProgress: row.max_in_progress,
  gates: commandsOf(row.gates),
  e2e: commandsOf(row.e2e),
  autoMerge: row.auto_merge === 1,
})

export const taskView = (row: TaskRow): ProjectTaskView => ({
  id: row.id,
  project: row.project,
  title: row.title,
  issueNumber: row.issue_number,
  prNumber: row.pr_number,
  state: stateOf(row.state),
  branch: row.branch,
  retries: row.retries,
  manualInterventions: row.manual_interventions,
  version: row.version,
  updatedAt: row.updated_at,
})
