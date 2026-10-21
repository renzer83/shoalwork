import { BeaconTest } from "@shoalwork/beacon"
import { withTempDb } from "@shoalwork/db/testing"
import { KanbanLive } from "@shoalwork/factory"
import { type Effect, Layer, ManagedRuntime, Redacted } from "effect"
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

const get = (path: string) => app.request(path, { headers: AUTH })

const sprintBody = (over: Record<string, unknown> = {}) => ({
  name: "Sprint 1",
  startsAt: "2026-10-21T00:00:00.000Z",
  endsAt: "2026-11-04T00:00:00.000Z",
  goal: "ship the board",
  ...over,
})

interface SprintsBody {
  readonly sprints: ReadonlyArray<{ readonly id: string; readonly name: string; readonly startsAt: string }>
}
interface SprintBody {
  readonly sprint: { readonly id: string; readonly name: string; readonly startsAt: string }
}
interface StreamBody {
  readonly events: ReadonlyArray<{ readonly type: string; readonly payload: Record<string, unknown> }>
}

const eventsOf = async (stream: string): Promise<StreamBody["events"]> =>
  (await json<StreamBody>(await get(`/events?stream=${encodeURIComponent(stream)}`))).events

describe("GET /projects/:slug/sprints", () => {
  it("answers 200 with an empty list for a project without sprints", async () => {
    await post("/projects", {
      slug: "empty-sprints",
      name: "e",
      repoUrl: "https://github.com/x/e",
      defaultBranch: "main",
    })

    const res = await get("/projects/empty-sprints/sprints")

    expect(res.status).toBe(200)
    expect(await json<SprintsBody>(res)).toEqual({ sprints: [] })
  })
})

describe("POST /projects/:slug/sprints", () => {
  it("creates a sprint, answers 201 and lists it", async () => {
    await post("/projects", {
      slug: "sprinted",
      name: "s",
      repoUrl: "https://github.com/x/s",
      defaultBranch: "main",
    })

    const res = await post("/projects/sprinted/sprints", sprintBody())

    expect(res.status).toBe(201)
    const created = await json<SprintBody>(res)
    expect(created.sprint.id.startsWith("sprint_")).toBe(true)
    expect(created.sprint.startsAt).toBe("2026-10-21T00:00:00.000Z")

    const listed = await json<SprintsBody>(await get("/projects/sprinted/sprints"))
    expect(listed.sprints.map((sprint) => sprint.id)).toContain(created.sprint.id)
  })

  it("writes sprint.created to the project stream with the sprint id", async () => {
    await post("/projects", {
      slug: "sprint-event",
      name: "s",
      repoUrl: "https://github.com/x/s",
      defaultBranch: "main",
    })
    const created = await json<SprintBody>(await post("/projects/sprint-event/sprints", sprintBody()))

    const events = await eventsOf("project:sprint-event")

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sprint.created",
        payload: expect.objectContaining({ sprintId: created.sprint.id }),
      }),
    )
  })

  it("rejects an end that is not after the start with 400", async () => {
    await post("/projects", {
      slug: "bad-dates",
      name: "b",
      repoUrl: "https://github.com/x/b",
      defaultBranch: "main",
    })

    const res = await post(
      "/projects/bad-dates/sprints",
      sprintBody({ startsAt: "2026-11-04T00:00:00.000Z", endsAt: "2026-10-21T00:00:00.000Z" }),
    )

    expect(res.status).toBe(400)
  })

  it("rejects a sprint without a name with 400", async () => {
    await post("/projects", {
      slug: "noname-sprint",
      name: "n",
      repoUrl: "https://github.com/x/n",
      defaultBranch: "main",
    })

    const res = await post("/projects/noname-sprint/sprints", sprintBody({ name: "" }))

    expect(res.status).toBe(400)
  })

  it("answers 404 for a project that does not exist", async () => {
    const res = await post("/projects/ghost-sprints/sprints", sprintBody())

    expect(res.status).toBe(404)
  })
})
