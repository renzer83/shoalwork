import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { Conflict, type ProjectTaskState } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect, test } from "vitest"
import { canTransition, Kanban, TRANSITIONS } from "../src/kanban.js"
import { KanbanLive } from "../src/kanban-live.js"

const TestLayer = Layer.provideMerge(KanbanLive, Layer.provideMerge(BeaconTest, withTempDb()))

// A board task in a known state, inserted directly (the sync and move paths write their own rows).
const insertTask = (
  sql: SqlClient,
  project: string,
  id: string,
  state: string,
  issueNumber: number | null = null,
) =>
  sql`INSERT INTO project_tasks
    (id, project, title, issue_number, pr_number, state, created_at, retries, manual_interventions, branch, version, updated_at, source)
    VALUES (${id}, ${project}, ${`task ${id}`}, ${issueNumber}, ${null}, ${state}, ${nowIso()}, 0, 0, ${null}, 0, ${null}, 'board')`

describe("transition table", () => {
  test("allows every transition listed in the table", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(canTransition(from as ProjectTaskState, to)).toBe(true)
      }
    }
  })

  test("rejects transitions outside the table", () => {
    expect(canTransition("backlog", "done")).toBe(false)
    expect(canTransition("done", "ready")).toBe(false)
    expect(canTransition("done", "blocked")).toBe(false)
    expect(canTransition("blocked", "in_progress")).toBe(false)
    expect(canTransition("cancelled", "in_review")).toBe(false)
    expect(canTransition("merging", "backlog")).toBe(false)
    expect(canTransition("blocked", "done")).toBe(false)
  })

  it.effect("an invalid move fails with Conflict", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const sql = yield* SqlClient
      yield* kanban.addProject({
        slug: "faturium",
        name: "Faturium",
        repoUrl: "https://github.com/x/faturium",
        defaultBranch: "main",
      })
      yield* insertTask(sql, "faturium", "ptask_1", "ready")
      const error = yield* Effect.flip(
        kanban.move({ project: "faturium", taskId: "ptask_1", to: "done", actor: "tester" }),
      )
      expect(error).toBeInstanceOf(Conflict)
      const tasks = yield* kanban.listTasks("faturium")
      expect(tasks.find((task) => task.id === "ptask_1")?.state).toBe("ready")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("wip limit", () => {
  it.effect("respects max_in_progress when a task enters in_progress", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const sql = yield* SqlClient
      yield* kanban.addProject({
        slug: "faturium",
        name: "Faturium",
        repoUrl: "https://github.com/x/faturium",
        defaultBranch: "main",
        maxInProgress: 1,
      })
      yield* insertTask(sql, "faturium", "ptask_a", "ready")
      yield* insertTask(sql, "faturium", "ptask_b", "ready")

      const first = yield* kanban.move({
        project: "faturium",
        taskId: "ptask_a",
        to: "in_progress",
        actor: "tester",
      })
      expect(first.state).toBe("in_progress")

      const error = yield* Effect.flip(
        kanban.move({ project: "faturium", taskId: "ptask_b", to: "in_progress", actor: "tester" }),
      )
      expect(error).toBeInstanceOf(Conflict)

      const tasks = yield* kanban.listTasks("faturium")
      expect(tasks.find((task) => task.id === "ptask_b")?.state).toBe("ready")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("project tasks query and CAS", () => {
  it.effect("listTasks returns an empty list for a project with no tasks", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const tasks = yield* kanban.listTasks("missing")
      expect(tasks).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("move increments version and manual_interventions for human actors", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const sql = yield* SqlClient
      yield* kanban.addProject({
        slug: "faturium",
        name: "Faturium",
        repoUrl: "https://github.com/x/faturium",
        defaultBranch: "main",
      })
      yield* insertTask(sql, "faturium", "ptask_cas", "ready")

      const moved = yield* kanban.move({
        project: "faturium",
        taskId: "ptask_cas",
        to: "in_progress",
        actor: "renan",
      })
      expect(moved.version).toBe(1)
      expect(moved.manualInterventions).toBe(1)

      const retried = yield* kanban.retry("faturium", "ptask_cas", "renan")
      expect(retried.version).toBe(2)
      expect(retried.retries).toBe(1)
      expect(retried.manualInterventions).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("prefers board rows over bridge rows for duplicate slugs", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const sql = yield* SqlClient
      // Insert bridge project
      yield* sql`INSERT INTO projects (slug, name, repo_url, default_branch, status, source, max_in_progress)
        VALUES ('dup', 'From Bridge', 'https://github.com/x/dup', 'main', 'active', 'bridge', 1)`
      // Add board project with same slug
      yield* kanban
        .addProject({
          slug: "dup",
          name: "From Board",
          repoUrl: "https://github.com/x/dup",
          defaultBranch: "main",
          maxInProgress: 5,
        })
        .pipe(Effect.ignore) // might conflict if exists, or insert directly with source board

      yield* sql`INSERT INTO projects (slug, name, repo_url, default_branch, status, source, max_in_progress)
        VALUES ('dup-2', 'Bridge Version', 'https://github.com/x/dup2', 'main', 'active', 'bridge', 1)`
      yield* sql`INSERT INTO projects (slug, name, repo_url, default_branch, status, source, max_in_progress)
        VALUES ('dup-2', 'Board Version', 'https://github.com/x/dup2', 'main', 'active', 'board', 5)`

      const projects = yield* kanban.listProjects()
      const p = projects.find((proj) => proj.slug === "dup-2")
      expect(p?.name).toBe("Board Version")
      expect(p?.maxInProgress).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )
})
