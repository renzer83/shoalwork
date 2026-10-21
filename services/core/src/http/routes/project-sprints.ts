import { SchemaViolation } from "@shoalwork/contracts"
import { Kanban } from "@shoalwork/factory"
import { Effect, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Who the events name when a sprint is created through the API.
const ACTOR = "api"

// Body of POST /projects/:slug/sprints: a named time box. Dates are ISO-8601 instants.
const SprintBody = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200)),
  startsAt: Schema.DateTimeUtcFromString,
  endsAt: Schema.DateTimeUtcFromString,
  goal: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
})

const listSprints = (slug: string) =>
  Effect.gen(function* () {
    const sprints = yield* (yield* Kanban).listSprints(slug)
    return { status: 200, body: { sprints } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const addSprint = (slug: string, raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(SprintBody)(raw)
    const startsAt = yield* Schema.encodeUnknownEffect(Schema.DateTimeUtcFromString)(body.startsAt)
    const endsAt = yield* Schema.encodeUnknownEffect(Schema.DateTimeUtcFromString)(body.endsAt)
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      return yield* Effect.fail(
        new SchemaViolation({ where: "sprint.endsAt", issue: "endsAt is not after startsAt" }),
      )
    }
    const sprint = yield* (yield* Kanban).addSprint({
      project: slug,
      name: body.name,
      startsAt,
      endsAt,
      goal: body.goal ?? "",
      actor: ACTOR,
    })
    return { status: 201, body: { sprint } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerSprintRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/projects/:slug/sprints", async (c) =>
    sendResponse(c, await runEffect(listSprints(c.req.param("slug")))),
  )
  app.post("/projects/:slug/sprints", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(addSprint(c.req.param("slug"), raw)))
  })
}
