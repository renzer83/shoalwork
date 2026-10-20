import { Beacon } from "@shoalwork/beacon"
import { Event, EventType } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Hard cap per response; a reader pages with `after` to get more.
export const MAX_EVENTS = 500

interface EventsQuery {
  readonly stream: string
  readonly after: number
  readonly types: ReadonlyArray<EventType> | undefined
}

const invalidQuery = (param: string): RouteResponse => ({
  status: 400,
  body: { error: "invalid query", param },
})

// Validates the query string by hand: it is three flat parameters, and the errors name the parameter.
const parseQuery = (params: {
  readonly stream: string | undefined
  readonly after: string | undefined
  readonly types: string | undefined
}):
  | { readonly ok: true; readonly query: EventsQuery }
  | { readonly ok: false; readonly response: RouteResponse } => {
  if (params.stream === undefined || params.stream === "") {
    return { ok: false, response: invalidQuery("stream") }
  }
  const after = params.after === undefined ? 0 : Number(params.after)
  if (!Number.isSafeInteger(after) || after < 0) {
    return { ok: false, response: invalidQuery("after") }
  }
  if (params.types === undefined) {
    return { ok: true, query: { stream: params.stream, after, types: undefined } }
  }
  const names = params.types.split(",").map((name) => name.trim())
  const types: Array<EventType> = []
  for (const name of names) {
    if (!Schema.is(EventType)(name)) {
      return { ok: false, response: invalidQuery("types") }
    }
    types.push(name)
  }
  return { ok: true, query: { stream: params.stream, after, types } }
}

const readEvents = (query: EventsQuery): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const selected = yield* beacon.readStream(query.stream, query.after).pipe(
      Stream.filter((event) => query.types === undefined || query.types.includes(event.type)),
      Stream.take(MAX_EVENTS),
      Stream.runCollect,
    )
    const events = yield* Schema.encodeEffect(Schema.Array(Event))(Array.from(selected)).pipe(Effect.orDie)
    return { status: 200, body: { events } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerEventRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/events", async (c) => {
    const parsed = parseQuery({
      stream: c.req.query("stream"),
      after: c.req.query("after"),
      types: c.req.query("types"),
    })
    if (!parsed.ok) {
      return sendResponse(c, parsed.response)
    }
    return sendResponse(c, await runEffect(readEvents(parsed.query)))
  })
}
