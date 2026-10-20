import { NotFound, TaskId, TaskSpec } from "@shoalwork/contracts"
import { Lead } from "@shoalwork/lead"
import { Effect, Schema, Struct } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Body of POST /tasks: the spec without the id, which the core assigns.
export const NewTaskBody = TaskSpec.mapFields(Struct.omit(["id"]))

const createTask = (raw: unknown): Effect.Effect<RouteResponse, never, Lead> =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(NewTaskBody)(raw)
    const lead = yield* Lead
    const task = yield* lead.intake(input)
    return { status: 201, body: { task } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// A malformed id cannot name a stored task, so it answers 404 like an unknown one.
const readTask = (rawId: string): Effect.Effect<RouteResponse, never, Lead> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(TaskId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Task", id: rawId })),
    )
    const lead = yield* Lead
    const view = yield* lead.get(id)
    return { status: 200, body: view } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerTaskRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.post("/tasks", async (c) => {
    // Unreadable JSON becomes a null body, which fails the schema with 400 like any other invalid body.
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(createTask(raw)))
  })

  app.get("/tasks/:id", async (c) => sendResponse(c, await runEffect(readTask(c.req.param("id")))))
}
