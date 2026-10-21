import { Beacon } from "@shoalwork/beacon"
import { type Event, ProjectTaskState, streamIds } from "@shoalwork/contracts"
import { Kanban } from "@shoalwork/factory"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import type { Hono } from "hono"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import { boardHtml } from "../board-ui.js"
import { registerMetricRoutes } from "./project-metrics.js"
import { registerSprintRoutes } from "./project-sprints.js"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Who the events name when a board move comes through the API.
const ACTOR = "api"

// The one event the board reads: every transition of the board is one `project_task.state_changed`.
const BOARD_TYPES = ["project_task.state_changed"] as const

// Body of POST /projects: the fields a new board project needs.
const ProjectBody = Schema.Struct({
  slug: Schema.String.check(Schema.isMaxLength(100)).check(Schema.isPattern(/^[a-z0-9_-]+$/)),
  name: Schema.String.check(Schema.isMaxLength(200)),
  repoUrl: Schema.String.check(Schema.isMaxLength(500)),
  defaultBranch: Schema.String.check(Schema.isMaxLength(100)),
  maxInProgress: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  // The checks of the delivery cycle (T-061): the worker's gates, the testpilot's commands, and the merge switch.
  gates: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
  ),
  e2e: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20)),
  ),
  autoMerge: Schema.optionalKey(Schema.Boolean),
})

// Body of POST /projects/:slug/tasks/:taskId/move: the target state and, optionally, why.
const MoveBody = Schema.Struct({
  to: ProjectTaskState,
  reason: Schema.optionalKey(Schema.String),
})

// Body of PATCH /projects/:slug/tasks/:taskId: exactly one action per call. `pause` is a move to `blocked`.
const TaskPatch = Schema.Union([
  Schema.Struct({ move: MoveBody }),
  Schema.Struct({ retry: Schema.Literal(true) }),
  Schema.Struct({ pause: Schema.Literal(true) }),
  Schema.Struct({ sprintId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))) }),
])

const patchTask = (slug: string, taskId: string, raw: unknown) =>
  Effect.gen(function* () {
    const patch = yield* Schema.decodeUnknownEffect(TaskPatch)(raw)
    const kanban = yield* Kanban
    const task =
      "move" in patch
        ? yield* kanban.move({
            project: slug,
            taskId,
            to: patch.move.to,
            reason: patch.move.reason,
            actor: ACTOR,
          })
        : "retry" in patch
          ? yield* kanban.retry(slug, taskId, ACTOR)
          : "pause" in patch
            ? yield* kanban.move({ project: slug, taskId, to: "blocked", reason: "paused", actor: ACTOR })
            : yield* kanban.setTaskSprint({ project: slug, taskId, sprintId: patch.sprintId, actor: ACTOR })
    return { status: 200, body: { task } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const listProjects = Effect.gen(function* () {
  const projects = yield* (yield* Kanban).listProjects()
  return { status: 200, body: { projects } } satisfies RouteResponse
}).pipe(Effect.catch(failureResponse))

const addProject = (raw: unknown) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(ProjectBody)(raw)
    const project = yield* (yield* Kanban).addProject(input)
    return { status: 201, body: { project } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const listTasks = (slug: string) =>
  Effect.gen(function* () {
    const tasks = yield* (yield* Kanban).listTasks(slug)
    return { status: 200, body: { tasks } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const syncProject = (slug: string) =>
  Effect.gen(function* () {
    const report = yield* (yield* Kanban).sync(slug)
    return { status: 200, body: { report } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const moveTask = (slug: string, taskId: string, raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(MoveBody)(raw)
    const task = yield* (yield* Kanban).move({
      project: slug,
      taskId,
      to: body.to,
      reason: body.reason,
      actor: ACTOR,
    })
    return { status: 200, body: { task } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const retryTask = (slug: string, taskId: string) =>
  Effect.gen(function* () {
    const task = yield* (yield* Kanban).retry(slug, taskId, ACTOR)
    return { status: 200, body: { task } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// Last-Event-ID is the position of the last event the client saw; absent or empty means "from the start".
const parseCursor = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") {
    return 0
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

// Subscribe before reading history: an event committed in between shows up in both. The board only wants the
// events of its own project stream, so both copies are filtered by `project:<slug>`.
const attachBoard = (slug: string, after: number) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const streamId = streamIds.project(slug)
    const live = yield* beacon.subscribe([...BOARD_TYPES])
    const history = yield* Stream.runCollect(
      beacon.readAll(after, [...BOARD_TYPES]).pipe(Stream.filter((event) => event.streamId === streamId)),
    ).pipe(Effect.orDie)
    return { live: live.pipe(Stream.filter((event) => event.streamId === streamId)), history }
  })

const sendEvent = (stream: SSEStreamingApi, event: Event): Promise<void> =>
  stream.writeSSE({ id: String(event.position), event: event.type, data: JSON.stringify(event.payload) })

const HEARTBEAT_MS = 15_000

const pump = async (
  stream: SSEStreamingApi,
  runEffect: RunEffect,
  slug: string,
  after: number,
): Promise<void> => {
  const scope = await runEffect(Scope.make())
  const close = (): Promise<void> => runEffect(Scope.close(scope, Exit.void))
  stream.onAbort(() => {
    void close()
  })
  const timer = setInterval(() => {
    stream.write(": ping\n\n").catch(() => undefined)
  }, HEARTBEAT_MS)
  try {
    const { live, history } = await runEffect(attachBoard(slug, after).pipe(Scope.provide(scope)))
    let cursor = after
    for (const event of history) {
      await sendEvent(stream, event)
      cursor = event.position
    }
    for await (const event of Stream.toAsyncIterable(live)) {
      if (stream.aborted) {
        break
      }
      if (event.position > cursor) {
        await sendEvent(stream, event)
      }
    }
  } catch (cause) {
    if (!stream.aborted) {
      throw cause
    }
  } finally {
    clearInterval(timer)
    await close()
  }
}

export const registerProjectRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/projects", async (c) => sendResponse(c, await runEffect(listProjects)))
  app.post("/projects", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(addProject(raw)))
  })
  app.post("/projects/:slug/sync", async (c) =>
    sendResponse(c, await runEffect(syncProject(c.req.param("slug")))),
  )
  app.get("/projects/:slug/tasks", async (c) =>
    sendResponse(c, await runEffect(listTasks(c.req.param("slug")))),
  )
  app.post("/projects/:slug/tasks/:taskId/move", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(moveTask(c.req.param("slug"), c.req.param("taskId"), raw)))
  })
  app.post("/projects/:slug/tasks/:taskId/retry", async (c) =>
    sendResponse(c, await runEffect(retryTask(c.req.param("slug"), c.req.param("taskId")))),
  )
  app.patch("/projects/:slug/tasks/:taskId", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(patchTask(c.req.param("slug"), c.req.param("taskId"), raw)))
  })
  registerSprintRoutes(app, runEffect)
  registerMetricRoutes(app, runEffect)
  app.get("/projects/:slug/board", (c) => c.html(boardHtml))
  app.get("/projects/:slug/live", (c) => {
    const after = parseCursor(c.req.header("last-event-id"))
    if (after === undefined) {
      return c.json({ error: "invalid header", param: "last-event-id" }, 400)
    }
    return streamSSE(c, (stream) => pump(stream, runEffect, c.req.param("slug"), after))
  })
}
