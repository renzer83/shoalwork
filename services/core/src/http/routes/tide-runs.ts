import { Beacon } from "@shoalwork/beacon"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// The last 30 days of firings count; a Tide's run list keeps the 50 most recent.
const RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const RUN_LIMIT = 50

// Projection of tide.fired (contracts/events/tide.ts): the fields the run list shows.
const TideFired = Schema.Struct({
  tideId: Schema.String,
  trigger: Schema.Literals(["cron", "event", "manual"]),
  taskId: Schema.String,
})

// The firings of one Tide, newest first. An id that names no Tide has no firings: the list is empty.
const tideRuns = (rawId: string) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const now = Date.now()
    const events = yield* beacon
      .readRange(["tide.fired"], { since: now - RUN_WINDOW_MS, until: now + 1 })
      .pipe(Stream.runCollect)
    const runs = Array.from(events).flatMap((event) => {
      const fired = Option.getOrUndefined(Schema.decodeUnknownOption(TideFired)(event.payload))
      return fired === undefined || fired.tideId !== rawId
        ? []
        : [{ at: DateTime.formatIso(event.occurredAt), taskId: fired.taskId, trigger: fired.trigger }]
    })
    runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    return { status: 200, body: { runs: runs.slice(0, RUN_LIMIT) } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerTideRunRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/tides/:id/runs", async (c) => sendResponse(c, await runEffect(tideRuns(c.req.param("id")))))
}
