import { NotFound, TaskId } from "@shoalwork/contracts"
import { replayFromServices } from "@shoalwork/lead"
import { Effect, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// A malformed id cannot name a stored task, so it answers 404 like an unknown one.
const decodeTaskId = (rawId: string) =>
  Schema.decodeUnknownEffect(TaskId)(rawId).pipe(
    Effect.mapError(() => new NotFound({ entity: "Task", id: rawId })),
  )

// POST /tasks/:id/replay: the task runs again as a new one (T-122). The body is the overrides, or empty.
const startReplay = (rawId: string, overrides: unknown) =>
  Effect.gen(function* () {
    const id = yield* decodeTaskId(rawId)
    const replay = yield* replayFromServices
    const started = yield* replay.run(id, overrides)
    return {
      status: 201,
      body: {
        replay: {
          id: started.replayId,
          sourceTaskId: started.sourceTaskId,
          taskId: started.task.id,
          overrides: started.overrides,
          baseSha: started.baseSha,
          contextFrozen: started.contextFrozen,
        },
      },
    } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// GET /replays/:id: both runs side by side.
const readReplay = (rawId: string) =>
  Effect.gen(function* () {
    const replay = yield* replayFromServices
    return { status: 200, body: yield* replay.compare(rawId) } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// No body means no overrides; a body that is not JSON fails the schema with 400 like any other invalid one.
const bodyOf = async (request: Request): Promise<unknown> => {
  const text = await request.text()
  if (text.trim() === "") return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const registerReplayRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.post("/tasks/:id/replay", async (c) =>
    sendResponse(c, await runEffect(startReplay(c.req.param("id"), await bodyOf(c.req.raw)))),
  )

  app.get("/replays/:id", async (c) => sendResponse(c, await runEffect(readReplay(c.req.param("id")))))
}
