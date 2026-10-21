import type { BeaconShape } from "@shoalwork/beacon"
import {
  Conflict,
  NotFound,
  type ProjectTaskState,
  type SchemaViolation,
  streamIds,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  ProjectRow,
  type ProjectTaskView,
  type ProjectView,
  stateOf,
  TaskRow,
  taskView,
} from "./kanban-rows.js"
// The board of one project (T-060). The log is the truth: every transition is one
// `project_task.state_changed` event and `project_tasks` is its projection.
export const DEFAULT_MAX_IN_PROGRESS = 3

// The legal transitions. A task moves forward, can be re-queued to `ready`, can be blocked from any active
// state, and only `done` and `cancelled` end it.
export const TRANSITIONS: Readonly<Record<ProjectTaskState, ReadonlyArray<ProjectTaskState>>> = {
  backlog: ["ready", "in_review", "blocked", "cancelled"],
  ready: ["backlog", "in_progress", "in_review", "blocked", "cancelled"],
  in_progress: ["in_review", "ready", "blocked", "cancelled"],
  in_review: ["testing", "in_progress", "ready", "done", "blocked", "cancelled"],
  testing: ["merging", "in_progress", "ready", "done", "blocked", "cancelled"],
  merging: ["done", "testing", "in_progress", "ready", "blocked", "cancelled"],
  done: [],
  blocked: ["ready", "cancelled"],
  cancelled: ["backlog"],
}

export const canTransition = (from: ProjectTaskState, to: ProjectTaskState): boolean =>
  (TRANSITIONS[from] ?? []).includes(to)

export interface NewProject {
  readonly slug: string
  readonly name: string
  readonly repoUrl: string
  readonly defaultBranch: string
  readonly maxInProgress?: number | undefined
  readonly gates?: ReadonlyArray<string> | undefined
  readonly e2e?: ReadonlyArray<string> | undefined
  readonly autoMerge?: boolean | undefined
}

export interface MoveInput {
  readonly project: string
  readonly taskId: string
  readonly to: ProjectTaskState
  readonly reason?: string | undefined
  readonly actor: string
}

export interface SyncReport {
  readonly project: string
  readonly applied: number
  readonly skipped: number
}

export interface KanbanShape {
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectView>, SqlError>
  readonly addProject: (input: NewProject) => Effect.Effect<ProjectView, Conflict | NotFound | SqlError>
  readonly listTasks: (project: string) => Effect.Effect<ReadonlyArray<ProjectTaskView>, SqlError>
  readonly move: (
    input: MoveInput,
  ) => Effect.Effect<ProjectTaskView, NotFound | Conflict | SchemaViolation | SqlError>
  readonly retry: (
    project: string,
    taskId: string,
    actor: string,
  ) => Effect.Effect<ProjectTaskView, NotFound | Conflict | SchemaViolation | SqlError>
  readonly sync: (
    project: string,
  ) => Effect.Effect<SyncReport, NotFound | Conflict | SchemaViolation | SqlError>
}

export class Kanban extends Context.Service<Kanban, KanbanShape>()("@shoalwork/Kanban") {}

// The board's own rows. A project imported from the bridge keeps its source; the board prefers its own.
const BOARD = "board"

export const decodeProjects = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ProjectRow))(rows).pipe(Effect.orDie)

export const decodeTasks = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(TaskRow))(rows).pipe(Effect.orDie)

export const projectBySlug = (sql: SqlClient, slug: string) =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT slug, name, repo_url, default_branch, status, max_in_progress, gates, e2e, auto_merge
      FROM projects WHERE slug = ${slug} ORDER BY CASE source WHEN 'board' THEN 0 ELSE 1 END, source LIMIT 1`
    const [row] = yield* decodeProjects(rows)
    return row
  })

export const tasksOf = (sql: SqlClient, project: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, project, title, issue_number, pr_number, state, retries,
      manual_interventions, branch, version, updated_at FROM project_tasks
      WHERE project = ${project} ORDER BY created_at, id`
    return yield* decodeTasks(rows)
  })

export const taskById = (sql: SqlClient, project: string, taskId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, project, title, issue_number, pr_number, state, retries,
      manual_interventions, branch, version, updated_at FROM project_tasks
      WHERE project = ${project} AND id = ${taskId} ORDER BY CASE source WHEN 'board' THEN 0 ELSE 1 END, source LIMIT 1`
    const [row] = yield* decodeTasks(rows)
    return row
  })

export const taskByIssue = (sql: SqlClient, project: string, issueNumber: number) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, project, title, issue_number, pr_number, state, retries,
      manual_interventions, branch, version, updated_at FROM project_tasks
      WHERE project = ${project} AND issue_number = ${issueNumber} ORDER BY CASE source WHEN 'board' THEN 0 ELSE 1 END, source LIMIT 1`
    const [row] = yield* decodeTasks(rows)
    return row
  })

export const inProgressCount = (sql: SqlClient, project: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM project_tasks
      WHERE project = ${project} AND state = 'in_progress'`
    return rows[0]?.n ?? 0
  })

export const conflict = (project: string, version: number, reason: string) =>
  new Conflict({ streamId: streamIds.project(project), expectedVersion: version, reason })

// One transition: the state is read, the transition is checked, the WIP limit is checked, the projection is
// written and the event is appended. The event is the truth, so it is appended inside the same transaction.
export const moveInTransaction = (
  sql: SqlClient,
  beacon: BeaconShape,
  input: MoveInput,
  bumpRetries: boolean,
): Effect.Effect<ProjectTaskView, NotFound | Conflict | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    const row = yield* taskById(sql, input.project, input.taskId)
    if (row === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "ProjectTask", id: input.taskId }))
    }
    const from = stateOf(row.state)
    if (!canTransition(from, input.to)) {
      return yield* Effect.fail(
        conflict(input.project, row.version, `invalid transition ${from} -> ${input.to}`),
      )
    }
    if (input.to === "in_progress") {
      const project = yield* projectBySlug(sql, input.project)
      const limit = project?.max_in_progress ?? DEFAULT_MAX_IN_PROGRESS
      const running = yield* inProgressCount(sql, input.project)
      if (running >= limit) {
        return yield* Effect.fail(
          conflict(input.project, row.version, `wip limit reached (${running}/${limit})`),
        )
      }
    }
    const now = nowIso()
    const isManual = input.actor !== "github" && input.actor !== "system"
    const updated = yield* sql<{ readonly id: string }>`UPDATE project_tasks
      SET state = ${input.to}, version = version + 1, updated_at = ${now}
      ${bumpRetries ? sql` , retries = retries + 1` : sql``}
      ${isManual ? sql` , manual_interventions = manual_interventions + 1` : sql``}
      WHERE project = ${input.project} AND id = ${row.id} AND version = ${row.version}
      RETURNING id`
    if (updated.length === 0) {
      return yield* Effect.fail(conflict(input.project, row.version, "concurrent update on project task"))
    }
    yield* beacon.append({
      streamId: streamIds.project(input.project),
      type: "project_task.state_changed",
      payload: {
        project: input.project,
        taskId: row.id,
        from,
        to: input.to,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      actor: input.actor,
      correlationId: row.id,
    })
    return taskView({
      ...row,
      state: input.to,
      version: row.version + 1,
      retries: bumpRetries ? row.retries + 1 : row.retries,
      manual_interventions: isManual ? row.manual_interventions + 1 : row.manual_interventions,
      updated_at: now,
    })
  })

// Creates the task of an issue when the project does not have it yet. The key is (project, issue number):
// the same issue never becomes two tasks.
export const ensureTask = (
  sql: SqlClient,
  project: string,
  issueNumber: number,
  title: string,
): Effect.Effect<TaskRow, SqlError> =>
  Effect.gen(function* () {
    const existing = yield* taskByIssue(sql, project, issueNumber)
    if (existing !== undefined) return existing
    const id = `ptask_${crypto.randomUUID()}`
    const now = nowIso()
    yield* sql`INSERT INTO project_tasks
      (id, project, title, issue_number, state, created_at, retries, manual_interventions, version, source)
      VALUES (${id}, ${project}, ${title}, ${issueNumber}, 'backlog', ${now}, 0, 0, 0, ${BOARD})`
    const created = yield* taskById(sql, project, id)
    if (created === undefined) {
      return yield* Effect.die("the task of the issue was not created")
    }
    return created
  })
