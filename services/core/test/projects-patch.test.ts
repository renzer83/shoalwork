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

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) })
const patch = (path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) })
const get = (path: string) => app.request(path, { headers: AUTH })

const createProject = (slug: string, maxInProgress?: number) =>
  post("/projects", {
    slug,
    name: slug,
    repoUrl: `https://github.com/x/${slug}`,
    defaultBranch: "main",
    ...(maxInProgress === undefined ? {} : { maxInProgress }),
  })

const insertTask = (project: string, id: string, state: string): Promise<void> =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO project_tasks
        (id, project, title, issue_number, pr_number, state, created_at, retries, manual_interventions, branch, version, updated_at, source)
        VALUES (${id}, ${project}, ${`task ${id}`}, ${null}, ${null}, ${state}, ${nowIso()}, 0, 0, ${null}, 0, ${null}, 'board')`
    }),
  )

interface TaskBody {
  readonly task: {
    readonly id: string
    readonly state: string
    readonly retries: number
    readonly sprintId: string | null
  }
}
interface ErrorBody {
  readonly error: string
  readonly reason?: string
}
interface StreamBody {
  readonly events: ReadonlyArray<{ readonly type: string; readonly payload: Record<string, unknown> }>
}

const eventsOf = async (stream: string): Promise<StreamBody["events"]> =>
  (await json<StreamBody>(await get(`/events?stream=${encodeURIComponent(stream)}`))).events

describe("PATCH /projects/:slug/tasks/:taskId move", () => {
  it("moves a task through the machine, answers 200 and writes state_changed", async () => {
    await createProject("patch-move")
    await insertTask("patch-move", "ptask_pm_1", "ready")

    const res = await patch("/projects/patch-move/tasks/ptask_pm_1", { move: { to: "in_progress" } })

    expect(res.status).toBe(200)
    expect((await json<TaskBody>(res)).task).toMatchObject({ id: "ptask_pm_1", state: "in_progress" })
    expect(await eventsOf("project:patch-move")).toContainEqual(
      expect.objectContaining({
        type: "project_task.state_changed",
        payload: expect.objectContaining({ from: "ready", to: "in_progress" }),
      }),
    )
  })

  it("answers 409 with the reason for an illegal transition and does not move the task", async () => {
    await createProject("patch-illegal")
    await insertTask("patch-illegal", "ptask_pi_1", "ready")

    const res = await patch("/projects/patch-illegal/tasks/ptask_pi_1", { move: { to: "done" } })

    expect(res.status).toBe(409)
    expect(await json<ErrorBody>(res)).toMatchObject({
      error: "conflict",
      reason: "invalid transition ready -> done",
    })
    const after = await json<{ tasks: ReadonlyArray<{ id: string; state: string }> }>(
      await get("/projects/patch-illegal/tasks"),
    )
    expect(after.tasks.find((task) => task.id === "ptask_pi_1")?.state).toBe("ready")
  })

  it("refuses to start a task past the WIP limit with 409", async () => {
    await createProject("patch-wip", 1)
    await insertTask("patch-wip", "ptask_wip_run", "in_progress")
    await insertTask("patch-wip", "ptask_wip_next", "ready")

    const res = await patch("/projects/patch-wip/tasks/ptask_wip_next", { move: { to: "in_progress" } })

    expect(res.status).toBe(409)
    expect((await json<ErrorBody>(res)).reason).toContain("wip limit reached")
  })

  it("answers 404 for a task that does not exist", async () => {
    await createProject("patch-missing")

    const res = await patch("/projects/patch-missing/tasks/ptask_nope", { move: { to: "ready" } })

    expect(res.status).toBe(404)
  })
})

describe("PATCH /projects/:slug/tasks/:taskId retry and pause", () => {
  it("retries an in-progress task back to ready and bumps its retries", async () => {
    await createProject("patch-retry")
    await insertTask("patch-retry", "ptask_pr_1", "in_progress")

    const res = await patch("/projects/patch-retry/tasks/ptask_pr_1", { retry: true })

    expect(res.status).toBe(200)
    expect((await json<TaskBody>(res)).task).toMatchObject({ state: "ready", retries: 1 })
  })

  it("pauses a task as a move to blocked and records the reason", async () => {
    await createProject("patch-pause")
    await insertTask("patch-pause", "ptask_pp_1", "ready")

    const res = await patch("/projects/patch-pause/tasks/ptask_pp_1", { pause: true })

    expect(res.status).toBe(200)
    expect((await json<TaskBody>(res)).task.state).toBe("blocked")
    expect(await eventsOf("project:patch-pause")).toContainEqual(
      expect.objectContaining({
        type: "project_task.state_changed",
        payload: expect.objectContaining({ to: "blocked", reason: "paused" }),
      }),
    )
  })

  it("refuses to pause a done task with 409", async () => {
    await createProject("patch-pause-done")
    await insertTask("patch-pause-done", "ptask_ppd_1", "done")

    const res = await patch("/projects/patch-pause-done/tasks/ptask_ppd_1", { pause: true })

    expect(res.status).toBe(409)
  })
})

describe("PATCH /projects/:slug/tasks/:taskId sprintId", () => {
  it("assigns a task to a sprint, clears it, and records each change as project_task.sprint_changed", async () => {
    await createProject("patch-sprint")
    await insertTask("patch-sprint", "ptask_ps_1", "backlog")
    const sprint = await json<{ sprint: { id: string } }>(
      await post("/projects/patch-sprint/sprints", {
        name: "S1",
        startsAt: "2026-10-21T00:00:00.000Z",
        endsAt: "2026-11-04T00:00:00.000Z",
        goal: "",
      }),
    )

    const assigned = await patch("/projects/patch-sprint/tasks/ptask_ps_1", { sprintId: sprint.sprint.id })
    expect(assigned.status).toBe(200)
    expect((await json<TaskBody>(assigned)).task.sprintId).toBe(sprint.sprint.id)

    const cleared = await patch("/projects/patch-sprint/tasks/ptask_ps_1", { sprintId: null })
    expect((await json<TaskBody>(cleared)).task.sprintId).toBeNull()

    const changes = (await eventsOf("project:patch-sprint")).filter(
      (event) => event.type === "project_task.sprint_changed",
    )
    expect(changes.map((event) => event.payload.to)).toEqual([sprint.sprint.id, null])
  })

  it("answers 404 for a sprint of the project that does not exist", async () => {
    await createProject("patch-sprint-missing")
    await insertTask("patch-sprint-missing", "ptask_psm_1", "backlog")

    const res = await patch("/projects/patch-sprint-missing/tasks/ptask_psm_1", { sprintId: "sprint_nope" })

    expect(res.status).toBe(404)
  })
})

describe("PATCH /projects/:slug/tasks/:taskId body", () => {
  it("rejects a body with no action with 400", async () => {
    await createProject("patch-body")
    await insertTask("patch-body", "ptask_pb_1", "ready")

    const res = await patch("/projects/patch-body/tasks/ptask_pb_1", {})

    expect(res.status).toBe(400)
  })
})
