import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { importFactoryExport } from "../src/import.js"

const EXPORT = {
  exportedAt: "2026-01-15T00:00:00.000Z",
  source: "bridge-sqlite",
  projects: [
    {
      slug: "faturium",
      name: "Faturium",
      repoUrl: "https://github.com/x/faturium",
      defaultBranch: "main",
      status: "active",
    },
  ],
  agents: [{ name: "worker", role: "worker" }],
  tasks: [
    {
      id: "t1",
      project: "faturium",
      title: "add sum(a,b)",
      state: "done",
      createdAt: "2026-01-10T00:00:00.000Z",
      retries: 1,
      manualInterventions: 0,
    },
  ],
  events: [{ taskId: "t1", type: "opened", at: "2026-01-10T00:00:00.000Z" }],
}

describe("importFactoryExport", () => {
  it.effect("rejects an invalid export", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(importFactoryExport({ nope: true }).pipe(Effect.provide(withTempDb())))
      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("imports once and is idempotent on a re-import", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const first = yield* importFactoryExport(EXPORT)
      const second = yield* importFactoryExport(EXPORT)
      expect(first).toEqual({ projects: 1, tasks: 1, events: 1 })
      expect(second).toEqual({ projects: 1, tasks: 1, events: 1 })

      const projects = yield* sql`SELECT slug FROM projects`
      const tasks = yield* sql`SELECT id FROM project_tasks`
      const events = yield* sql`SELECT task_id FROM factory_events`
      expect(projects.length).toBe(1)
      expect(tasks.length).toBe(1)
      expect(events.length).toBe(1)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("updates a task that changed between exports", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* importFactoryExport(EXPORT)
      const changed = {
        ...EXPORT,
        tasks: [{ ...EXPORT.tasks[0], title: "renamed", retries: 2 }],
      }
      yield* importFactoryExport(changed)

      const rows = yield* sql`SELECT title, retries FROM project_tasks WHERE id = 't1'`
      expect(rows).toEqual([{ title: "renamed", retries: 2 }])
    }).pipe(Effect.provide(withTempDb())),
  )
})
