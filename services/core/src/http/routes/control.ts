import { BotRegistry } from "@shoalwork/bots"
import { NotFound, TaskId } from "@shoalwork/contracts"
import { botTarget, Control, GLOBAL, type ScopeTarget, taskTarget } from "@shoalwork/lead"
import { Effect, Schema } from "effect"
import type { Context, Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Who the events and the verdict evidence name when the request comes through the API.
const BY = "api"

// Without `bot` the action covers everything; with it, one Bot (by name or id).
const ScopeBody = Schema.Struct({ bot: Schema.optional(Schema.String) })

const scopeOf = (raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(ScopeBody)(raw)
    if (body.bot === undefined) {
      return GLOBAL
    }
    const name = body.bot
    const bots = yield* (yield* BotRegistry).list()
    const found = bots.find((bot) => bot.id === name || bot.name === name)
    if (found === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Bot", id: name }))
    }
    return botTarget(found.id)
  })

const stopScope = (raw: unknown) =>
  Effect.gen(function* () {
    const target: ScopeTarget = yield* scopeOf(raw)
    const report = yield* (yield* Control).stop(target, BY)
    return { status: 200, body: { stopped: report.tasks } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const changeScope = (action: "pause" | "resume", raw: unknown) =>
  Effect.gen(function* () {
    const target: ScopeTarget = yield* scopeOf(raw)
    const control = yield* Control
    yield* action === "pause" ? control.pause(target, BY) : control.resume(target, BY)
    return { status: 200, body: { ok: true } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// A malformed id cannot name a stored task, so it answers 404 like an unknown one.
const stopTask = (rawId: string) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(TaskId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Task", id: rawId })),
    )
    const report = yield* (yield* Control).stop(taskTarget(id), BY)
    return { status: 200, body: { stopped: report.tasks } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const readStatus = Effect.gen(function* () {
  const status = yield* (yield* Control).status()
  return { status: 200, body: status } satisfies RouteResponse
}).pipe(Effect.catch(failureResponse))

// An empty body means "everything"; a body that is not JSON becomes null, which fails the schema with a 400.
const readBody = async (c: Context): Promise<unknown> => {
  const text = await c.req.text().catch(() => "")
  if (text.trim() === "") {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

export const registerControlRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.post("/control/stop", async (c) => sendResponse(c, await runEffect(stopScope(await readBody(c)))))
  app.post("/control/pause", async (c) =>
    sendResponse(c, await runEffect(changeScope("pause", await readBody(c)))),
  )
  app.post("/control/resume", async (c) =>
    sendResponse(c, await runEffect(changeScope("resume", await readBody(c)))),
  )
  app.get("/control/status", async (c) => sendResponse(c, await runEffect(readStatus)))
  app.post("/tasks/:id/stop", async (c) => sendResponse(c, await runEffect(stopTask(c.req.param("id")))))
}
