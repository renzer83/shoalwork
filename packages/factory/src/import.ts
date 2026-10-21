import { SchemaViolation } from "@shoalwork/contracts"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { FactoryExport } from "./export-schema.js"

const iso = (at: DateTime.Utc | undefined): string | null =>
  at === undefined ? null : DateTime.formatIso(at)

export interface ImportReport {
  // Number of rows written for each kind. A re-import converges to the same rows (idempotent).
  readonly projects: number
  readonly tasks: number
  readonly events: number
}

const decode = (input: unknown): Effect.Effect<FactoryExport, SchemaViolation> =>
  Schema.decodeUnknownEffect(FactoryExport)(input).pipe(
    Effect.mapError((error) => new SchemaViolation({ where: "factory.import", issue: error.issue })),
  )

const upsertProjects = (sql: SqlClient, exported: FactoryExport): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    for (const project of exported.projects) {
      yield* sql`INSERT INTO projects (slug, name, repo_url, default_branch, status, source)
        VALUES (${project.slug}, ${project.name}, ${project.repoUrl}, ${project.defaultBranch},
          ${project.status}, ${exported.source})
        ON CONFLICT (source, slug) DO UPDATE SET
          name = excluded.name,
          repo_url = excluded.repo_url,
          default_branch = excluded.default_branch,
          status = excluded.status`
    }
    return exported.projects.length
  })

const upsertTasks = (sql: SqlClient, exported: FactoryExport): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    for (const task of exported.tasks) {
      yield* sql`INSERT INTO project_tasks
        (id, project, title, issue_number, pr_number, state, created_at, started_at, merged_at, closed_at,
         retries, manual_interventions, tokens_in, tokens_out, usd, source)
        VALUES (${task.id}, ${task.project}, ${task.title}, ${task.issueNumber ?? null}, ${task.prNumber ?? null},
          ${task.state}, ${DateTime.formatIso(task.createdAt)}, ${iso(task.startedAt)},
          ${iso(task.mergedAt)}, ${iso(task.closedAt)}, ${task.retries},
          ${task.manualInterventions}, ${task.tokensIn ?? null}, ${task.tokensOut ?? null}, ${task.usd ?? null},
          ${exported.source})
        ON CONFLICT (source, id) DO UPDATE SET
          project = excluded.project,
          title = excluded.title,
          issue_number = excluded.issue_number,
          pr_number = excluded.pr_number,
          state = excluded.state,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          merged_at = excluded.merged_at,
          closed_at = excluded.closed_at,
          retries = excluded.retries,
          manual_interventions = excluded.manual_interventions,
          tokens_in = excluded.tokens_in,
          tokens_out = excluded.tokens_out,
          usd = excluded.usd`
    }
    return exported.tasks.length
  })

// Events carry no id, so re-imports dedupe on the UNIQUE (source, task_id, type, at): INSERT OR IGNORE keeps a
// second run from duplicating a row while still accepting genuinely new events.
const insertEvents = (sql: SqlClient, exported: FactoryExport): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    for (const event of exported.events) {
      const data = event.data === undefined ? null : JSON.stringify(event.data)
      yield* sql`INSERT OR IGNORE INTO factory_events (task_id, type, at, data, source)
        VALUES (${event.taskId}, ${event.type}, ${DateTime.formatIso(event.at)}, ${data}, ${exported.source})`
    }
    return exported.events.length
  })

// Imports a bridge export, idempotently, in one transaction: every row lands or none does. `agents` is validated
// but not stored (it feeds T-059 templates / T-038 memory instead).
export const importFactoryExport = (
  input: unknown,
): Effect.Effect<ImportReport, SchemaViolation | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const exported = yield* decode(input)
    const sql = yield* SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const projects = yield* upsertProjects(sql, exported)
        const tasks = yield* upsertTasks(sql, exported)
        const events = yield* insertEvents(sql, exported)
        return { projects, tasks, events }
      }),
    )
  })
