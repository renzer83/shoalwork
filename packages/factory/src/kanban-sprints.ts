import type { BeaconShape } from "@shoalwork/beacon"
import { type Conflict, NotFound, type SchemaViolation, streamIds } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type NewSprint, projectBySlug, type SetTaskSprintInput, taskById } from "./kanban.js"
import { type ProjectTaskView, SprintRow, type SprintView, sprintView, taskView } from "./kanban-rows.js"

// Sprints of a project's board (T-115). A task belongs to one sprint or to none. Each change is one event on
// the project stream, appended in the same transaction as its projection.

const decodeSprints = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(SprintRow))(rows).pipe(Effect.orDie)

export const sprintsOf = (sql: SqlClient, project: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, project, name, starts_at, ends_at, goal FROM sprints
      WHERE project = ${project} ORDER BY starts_at, id`
    return (yield* decodeSprints(rows)).map(sprintView)
  })

const sprintById = (sql: SqlClient, project: string, id: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, project, name, starts_at, ends_at, goal FROM sprints
      WHERE project = ${project} AND id = ${id}`
    const [row] = yield* decodeSprints(rows)
    return row
  })

export const addSprintInTransaction = (
  sql: SqlClient,
  beacon: BeaconShape,
  input: NewSprint,
): Effect.Effect<SprintView, NotFound | Conflict | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    const project = yield* projectBySlug(sql, input.project)
    if (project === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Project", id: input.project }))
    }
    const id = `sprint_${crypto.randomUUID()}`
    yield* sql`INSERT INTO sprints (id, project, name, starts_at, ends_at, goal)
      VALUES (${id}, ${input.project}, ${input.name}, ${input.startsAt}, ${input.endsAt}, ${input.goal})`
    yield* beacon.append({
      streamId: streamIds.project(input.project),
      type: "sprint.created",
      payload: {
        project: input.project,
        sprintId: id,
        name: input.name,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        goal: input.goal,
      },
      actor: input.actor,
      correlationId: id,
    })
    return {
      id,
      project: input.project,
      name: input.name,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      goal: input.goal,
    }
  })

export const setTaskSprintInTransaction = (
  sql: SqlClient,
  beacon: BeaconShape,
  input: SetTaskSprintInput,
): Effect.Effect<ProjectTaskView, NotFound | Conflict | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    const row = yield* taskById(sql, input.project, input.taskId)
    if (row === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "ProjectTask", id: input.taskId }))
    }
    if (input.sprintId !== null) {
      const sprint = yield* sprintById(sql, input.project, input.sprintId)
      if (sprint === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Sprint", id: input.sprintId }))
      }
    }
    if (row.sprint_id === input.sprintId) {
      return taskView(row)
    }
    yield* sql`UPDATE project_tasks SET sprint_id = ${input.sprintId}
      WHERE project = ${input.project} AND id = ${row.id}`
    yield* beacon.append({
      streamId: streamIds.project(input.project),
      type: "project_task.sprint_changed",
      payload: { project: input.project, taskId: row.id, from: row.sprint_id, to: input.sprintId },
      actor: input.actor,
      correlationId: row.id,
    })
    return taskView({ ...row, sprint_id: input.sprintId })
  })
