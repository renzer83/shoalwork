import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import {
  type Conflict,
  GithubIssuesPayload,
  GithubPullRequestPayload,
  GithubWorkflowRunPayload,
  NotFound,
  type SchemaViolation,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  canTransition,
  conflict,
  DEFAULT_MAX_IN_PROGRESS,
  decodeProjects,
  ensureTask,
  Kanban,
  type KanbanShape,
  type MoveInput,
  moveInTransaction,
  type NewProject,
  projectBySlug,
  type SyncReport,
  taskById,
  taskByIssue,
  tasksOf,
} from "./kanban.js"
import { type ProjectView, projectView, stateOf, taskView } from "./kanban-rows.js"
import { decideDelivery, type GithubDelivery, repoOf } from "./sync-github.js"

// The board reads the GitHub events of the log and applies them. The delivery id is the idempotency key:
// the same delivery twice is one task and one transition.
const DELIVERY_TYPES = ["github.issues", "github.pull_request", "github.workflow_run"] as const

const decodeDelivery = (type: string, payload: unknown): Effect.Effect<GithubDelivery | undefined> => {
  if (type === "github.issues") {
    return Schema.decodeUnknownEffect(GithubIssuesPayload)(payload).pipe(
      Effect.map((body) => ({
        type: "github.issues" as const,
        deliveryId: body.deliveryId,
        repo: body.repo,
        action: body.action,
        number: body.number,
        title: body.title,
        ...(body.labels === undefined ? {} : { labels: body.labels }),
      })),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }
  if (type === "github.pull_request") {
    return Schema.decodeUnknownEffect(GithubPullRequestPayload)(payload).pipe(
      Effect.map((body) => ({
        type: "github.pull_request" as const,
        deliveryId: body.deliveryId,
        repo: body.repo,
        action: body.action,
        number: body.number,
        title: body.title,
        ...(body.headBranch === undefined ? {} : { headBranch: body.headBranch }),
        ...(body.merged === undefined ? {} : { merged: body.merged }),
      })),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }
  if (type === "github.workflow_run") {
    return Schema.decodeUnknownEffect(GithubWorkflowRunPayload)(payload).pipe(
      Effect.map((body) => ({
        type: "github.workflow_run" as const,
        deliveryId: body.deliveryId,
        repo: body.repo,
        action: body.action,
        ...(body.conclusion === undefined ? {} : { conclusion: body.conclusion }),
        ...(body.headBranch === undefined ? {} : { headBranch: body.headBranch }),
      })),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }
  return Effect.succeed(undefined)
}

const taskByBranch = (sql: SqlClient, project: string, branch: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly id: string }>`SELECT id FROM project_tasks
      WHERE project = ${project} AND branch = ${branch} LIMIT 1`
    const id = rows[0]?.id
    return id === undefined ? undefined : yield* taskById(sql, project, id)
  })

// The task a green CI belongs to: the one of the branch, or the only one waiting for review when no branch is given.
const taskUnderTest = (sql: SqlClient, project: string, branch: string | undefined) =>
  Effect.gen(function* () {
    if (branch !== undefined) {
      return yield* taskByBranch(sql, project, branch)
    }
    const inReview = (yield* tasksOf(sql, project)).filter((task) => task.state === "in_review")
    return inReview.length === 1 ? inReview[0] : undefined
  })

// One delivery: the claim, the task and the transition, in one transaction.
const applyDelivery = (
  sql: SqlClient,
  beacon: BeaconShape,
  project: string,
  delivery: GithubDelivery,
  position?: number,
): Effect.Effect<boolean, Conflict | NotFound | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    const seen = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM kanban_deliveries
      WHERE project = ${project} AND delivery_id = ${delivery.deliveryId}`
    if ((seen[0]?.n ?? 0) > 0) return false

    const decision = decideDelivery(delivery)
    if (decision._tag === "ignore") return false

    const recordDelivery = () =>
      sql`INSERT INTO kanban_deliveries (project, delivery_id, kind, applied_at, position)
        VALUES (${project}, ${delivery.deliveryId}, ${delivery.type}, ${nowIso()}, ${position ?? null})`

    if (decision._tag === "create") {
      const task = yield* ensureTask(sql, project, decision.issueNumber, decision.title)
      if (decision.to === "ready" && stateOf(task.state) === "backlog") {
        yield* moveInTransaction(
          sql,
          beacon,
          { project, taskId: task.id, to: "ready", reason: "ready label", actor: "github" },
          false,
        )
      }
      yield* recordDelivery()
      return true
    }
    if (decision._tag === "review") {
      const task = yield* taskByIssue(sql, project, decision.issueNumber)
      if (task === undefined) return false
      yield* sql`UPDATE project_tasks SET pr_number = ${decision.prNumber}, branch = ${decision.branch ?? null}
        WHERE project = ${project} AND id = ${task.id}`
      if (canTransition(stateOf(task.state), "in_review")) {
        yield* moveInTransaction(
          sql,
          beacon,
          { project, taskId: task.id, to: "in_review", reason: "pr opened", actor: "github" },
          false,
        )
      }
      yield* recordDelivery()
      return true
    }
    if (decision._tag === "testing") {
      const task = yield* taskUnderTest(sql, project, decision.branch)
      if (task === undefined) return false
      if (canTransition(stateOf(task.state), "testing")) {
        yield* moveInTransaction(
          sql,
          beacon,
          { project, taskId: task.id, to: "testing", reason: "ci green", actor: "github" },
          false,
        )
      }
      yield* recordDelivery()
      return true
    }
    if (decision._tag === "done") {
      const task = yield* taskByIssue(sql, project, decision.issueNumber)
      if (task === undefined) return false
      yield* sql`UPDATE project_tasks SET pr_number = ${decision.prNumber} WHERE project = ${project} AND id = ${task.id}`
      if (canTransition(stateOf(task.state), "done")) {
        yield* moveInTransaction(
          sql,
          beacon,
          { project, taskId: task.id, to: "done", reason: "pr merged", actor: "github" },
          false,
        )
      }
      yield* recordDelivery()
      return true
    }
    return false
  })

export const KanbanLive: Layer.Layer<Kanban, never, SqlClient | Beacon> = Layer.effect(
  Kanban,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon

    const listProjects = () =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT slug, name, repo_url, default_branch, status, max_in_progress
          FROM projects ORDER BY CASE source WHEN 'board' THEN 0 ELSE 1 END, source, slug`
        const all = (yield* decodeProjects(rows)).map(projectView)
        const seen = new Set<string>()
        const unique: Array<ProjectView> = []
        for (const p of all) {
          if (!seen.has(p.slug)) {
            seen.add(p.slug)
            unique.push(p)
          }
        }
        return unique
      })

    const addProject = (input: NewProject) =>
      Effect.gen(function* () {
        const existing = yield* projectBySlug(sql, input.slug)
        if (existing !== undefined) {
          return yield* Effect.fail(conflict(input.slug, 0, "the project already exists"))
        }
        const limit = input.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS
        yield* sql`INSERT INTO projects (slug, name, repo_url, default_branch, status, source, max_in_progress)
          VALUES (${input.slug}, ${input.name}, ${input.repoUrl}, ${input.defaultBranch}, 'active', 'board', ${limit})`
        const created = yield* projectBySlug(sql, input.slug)
        if (created === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "Project", id: input.slug }))
        }
        return projectView(created)
      })

    const listTasks = (project: string) =>
      Effect.gen(function* () {
        const rows = yield* tasksOf(sql, project)
        return rows.map(taskView)
      })

    const move = (input: MoveInput) => sql.withTransaction(moveInTransaction(sql, beacon, input, false))

    const retry = (project: string, taskId: string, actor: string) =>
      sql.withTransaction(
        moveInTransaction(sql, beacon, { project, taskId, to: "ready", reason: "retry", actor }, true),
      )

    const sync = (
      project: string,
    ): Effect.Effect<SyncReport, NotFound | Conflict | SchemaViolation | SqlError> =>
      Effect.gen(function* () {
        const found = yield* projectBySlug(sql, project)
        if (found === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "Project", id: project }))
        }
        const repo = repoOf(found.repo_url)
        const posRows = yield* sql<{ readonly max_pos: number | null }>`SELECT MAX(position) AS max_pos
          FROM kanban_deliveries WHERE project = ${project}`
        const afterPosition = posRows[0]?.max_pos ?? 0
        const events = yield* Stream.runCollect(beacon.readAll(afterPosition, [...DELIVERY_TYPES])).pipe(
          Effect.orDie,
        )
        let applied = 0
        let skipped = 0
        for (const event of events) {
          const delivery = yield* decodeDelivery(event.type, event.payload)
          if (delivery === undefined || repo === undefined || delivery.repo.toLowerCase() !== repo) {
            skipped += 1
            continue
          }
          const outcome = yield* sql.withTransaction(
            applyDelivery(sql, beacon, project, delivery, event.position),
          )
          if (outcome) applied += 1
          else skipped += 1
        }
        return { project, applied, skipped }
      })

    const shape: KanbanShape = {
      listProjects,
      addProject,
      listTasks,
      move,
      retry: (project, taskId, actor) => retry(project, taskId, actor),
      sync,
    }
    return shape
  }),
)
