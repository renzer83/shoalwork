import { BeaconTest } from "@shoalwork/beacon"
import { nowIso } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { KanbanLive } from "@shoalwork/factory"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" }

const TestLayer = Layer.provideMerge(KanbanLive, Layer.provideMerge(BeaconTest, withTempDb()))
const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

afterAll(() => runtime.dispose())

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

const projectBody = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug,
  repoUrl: `https://github.com/x/${slug}`,
  defaultBranch: "main",
  ...over,
})

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) })

const get = (path: string, headers: Record<string, string> = AUTH) => app.request(path, { headers })

// A board task in a known state, inserted directly (the sync and move paths write their own rows).
const insertTask = (project: string, id: string, state: string): Promise<void> =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO project_tasks
        (id, project, title, issue_number, pr_number, state, created_at, retries, manual_interventions, branch, version, updated_at, source)
        VALUES (${id}, ${project}, ${`task ${id}`}, ${null}, ${null}, ${state}, ${nowIso()}, 0, 0, ${null}, 0, ${null}, 'board')`
    }),
  )

interface ProjectsBody {
  readonly projects: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly status: string }>
}
interface ProjectBody {
  readonly project: { readonly slug: string; readonly maxInProgress: number }
}
interface TasksBody {
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly state: string; readonly retries: number }>
}
interface TaskBody {
  readonly task: { readonly id: string; readonly state: string; readonly retries: number }
}
interface SyncBody {
  readonly report: { readonly project: string; readonly applied: number; readonly skipped: number }
}
interface ErrorBody {
  readonly error: string
  readonly reason?: string
}

describe("GET /projects", () => {
  it("answers 200 with the list of projects", async () => {
    await post("/projects", projectBody("listed"))
    const res = await get("/projects")

    expect(res.status).toBe(200)
    const body = await json<ProjectsBody>(res)
    expect(body.projects).toContainEqual(expect.objectContaining({ slug: "listed", status: "active" }))
  })

  it("requires the bearer token", async () => {
    const res = await app.request("/projects")

    expect(res.status).toBe(401)
  })
})

describe("POST /projects", () => {
  it("creates a project and answers 201", async () => {
    const res = await post("/projects", projectBody("faturium"))

    expect(res.status).toBe(201)
    const body = await json<ProjectBody>(res)
    expect(body.project).toMatchObject({ slug: "faturium", maxInProgress: 3 })
  })

  it("answers 409 for a slug that already exists", async () => {
    await post("/projects", projectBody("dup"))
    const res = await post("/projects", projectBody("dup"))

    expect(res.status).toBe(409)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "conflict" })
  })

  it("rejects a body without a name with 400", async () => {
    const { name: _name, ...withoutName } = projectBody("noname")
    const res = await post("/projects", withoutName)

    expect(res.status).toBe(400)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "invalid request" })
  })
})

describe("GET /projects/:slug/tasks", () => {
  it("answers 200 with the tasks of the project, ordered by creation", async () => {
    await insertTask("gamma", "ptask_list_1", "ready")
    await insertTask("gamma", "ptask_list_2", "in_progress")

    const res = await get("/projects/gamma/tasks")

    expect(res.status).toBe(200)
    const body = await json<TasksBody>(res)
    expect(body.tasks.map((task) => task.id)).toEqual(["ptask_list_1", "ptask_list_2"])
    expect(body.tasks[0]).toMatchObject({ id: "ptask_list_1", state: "ready", retries: 0 })
  })

  it("answers 200 with an empty list for an unknown project", async () => {
    const res = await get("/projects/ghost/tasks")

    expect(res.status).toBe(200)
    expect(await json<TasksBody>(res)).toEqual({ tasks: [] })
  })
})

describe("POST /projects/:slug/tasks/:taskId/move", () => {
  it("moves a task and answers 200 with the updated task", async () => {
    await insertTask("gamma", "ptask_move_ok", "ready")

    const res = await post("/projects/gamma/tasks/ptask_move_ok/move", { to: "in_progress" })

    expect(res.status).toBe(200)
    const body = await json<TaskBody>(res)
    expect(body.task).toMatchObject({ id: "ptask_move_ok", state: "in_progress" })
  })

  it("answers 409 for an illegal transition", async () => {
    await insertTask("gamma", "ptask_move_conflict", "ready")

    const res = await post("/projects/gamma/tasks/ptask_move_conflict/move", { to: "done" })

    expect(res.status).toBe(409)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "conflict" })
  })

  it("answers 404 for a task that does not exist", async () => {
    const res = await post("/projects/gamma/tasks/ptask_missing/move", { to: "ready" })

    expect(res.status).toBe(404)
  })

  it("rejects a body with an unknown state with 400", async () => {
    await insertTask("gamma", "ptask_move_bad", "ready")

    const res = await post("/projects/gamma/tasks/ptask_move_bad/move", { to: "exploded" })

    expect(res.status).toBe(400)
  })
})

describe("POST /projects/:slug/tasks/:taskId/retry", () => {
  it("moves a task back to ready and bumps its retries", async () => {
    await insertTask("gamma", "ptask_retry_1", "in_progress")

    const res = await post("/projects/gamma/tasks/ptask_retry_1/retry", {})

    expect(res.status).toBe(200)
    const body = await json<TaskBody>(res)
    expect(body.task).toMatchObject({ id: "ptask_retry_1", state: "ready", retries: 1 })
  })
})

describe("POST /projects/:slug/sync", () => {
  it("answers 200 with the sync report", async () => {
    await post("/projects", projectBody("delta"))

    const res = await post("/projects/delta/sync", {})

    expect(res.status).toBe(200)
    const body = await json<SyncBody>(res)
    expect(body.report).toMatchObject({ project: "delta", applied: 0 })
  })

  it("answers 404 for an unknown project", async () => {
    const res = await post("/projects/ghost/sync", {})

    expect(res.status).toBe(404)
  })
})

describe("GET /projects/:slug/board", () => {
  it("serves the board page as text/html without a token", async () => {
    const res = await app.request("/projects/gamma/board")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const page = await res.text()
    expect(page).toContain("<title>board · shoalwork</title>")
    expect(page).not.toContain(TOKEN)
  })

  it("streams the project live feed with ?token= and answers 401 without it", async () => {
    expect((await app.request("/projects/gamma/live")).status).toBe(401)
    expect((await app.request("/projects/gamma/live?token=wrong")).status).toBe(401)

    const res = await app.request(`/projects/gamma/live?token=${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    await res.body?.cancel()
  })
})
