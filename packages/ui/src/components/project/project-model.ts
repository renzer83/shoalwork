import type { BoardTask } from "@shoalwork/api-client"
import type { ProjectTaskState } from "@shoalwork/contracts"

// The columns of the board, in flow order: the states of T-060.
export const COLUMNS: ReadonlyArray<ProjectTaskState> = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "testing",
  "merging",
  "done",
  "blocked",
  "cancelled",
]

const RUNNING: ReadonlyArray<ProjectTaskState> = ["in_progress", "in_review", "testing", "merging"]

export type Health = "attention" | "running" | "idle" | "unknown"

export interface HealthCounts {
  readonly total: number
  readonly running: number
  readonly blocked: number
}

export const countsOf = (tasks: ReadonlyArray<Pick<BoardTask, "state">>): HealthCounts => ({
  total: tasks.length,
  running: tasks.filter((task) => RUNNING.includes(task.state)).length,
  blocked: tasks.filter((task) => task.state === "blocked").length,
})

export const healthOf = (counts: HealthCounts): Health => {
  if (counts.blocked > 0) return "attention"
  return counts.running > 0 ? "running" : "idle"
}

// The sprint filter of the board: every task, the tasks of no sprint, or the tasks of one sprint.
export type SprintFilter =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "sprint"; readonly id: string }

export const inSprint = (task: Pick<BoardTask, "sprintId">, filter: SprintFilter): boolean => {
  if (filter.kind === "all") return true
  if (filter.kind === "none") return task.sprintId === null
  return task.sprintId === filter.id
}

// How long a task has been in its state; "—" when there is no usable time.
export const ageText = (updatedAt: string | null, now: number): string => {
  if (updatedAt === null) return "—"
  const at = Date.parse(updatedAt)
  if (Number.isNaN(at)) return "—"
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`
}

export const formatMetric = (key: string, value: number | null): string => {
  if (value === null) return "—"
  switch (key) {
    case "lead_time_median_ms":
      return value >= 3_600_000 ? `${(value / 3_600_000).toFixed(1)} h` : `${(value / 60_000).toFixed(1)} min`
    case "throughput_per_day":
      return `${value.toFixed(2)}/day`
    case "tokens_per_task":
      return Math.round(value).toLocaleString("en-US")
    case "no_intervention_pct":
      return `${value.toFixed(0)}%`
    case "idle_seconds":
      return `${value.toFixed(0)} s`
    case "stuck_per_week":
      return `${value.toFixed(2)}/week`
    default:
      return String(value)
  }
}

// Only https links leave the app: the repo URL is typed by a person.
export const githubLinkOf = (
  repoUrl: string,
  task: Pick<BoardTask, "issueNumber" | "prNumber">,
): string | undefined => {
  if (!repoUrl.startsWith("https://")) return undefined
  const base = repoUrl.replace(/\/+$/, "")
  if (task.prNumber !== null) return `${base}/pull/${task.prNumber}`
  if (task.issueNumber !== null) return `${base}/issues/${task.issueNumber}`
  return undefined
}

export const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

// A refused action says why (the machine's reason); anything else reads as a plain failure.
export const failureText = (error: unknown): string => {
  if (!(error instanceof Object) || !("status" in error)) return "Request failed"
  const body = "body" in error ? error.body : undefined
  if (body instanceof Object && "reason" in body && typeof body.reason === "string") {
    return `Refused: ${body.reason}`
  }
  return `Request failed (HTTP ${String(error.status)})`
}
