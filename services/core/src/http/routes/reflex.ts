import { Beacon } from "@shoalwork/beacon"
import { exportDataset, toNdjsonLine } from "@shoalwork/reflex"
import { Effect, Stream } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

type Exported =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: RouteResponse }

// The whole dataset in one body: the export is a batch for the fine-tune, not a page to scroll.
const exportNdjson = Effect.gen(function* () {
  const beacon = yield* Beacon
  const lines = yield* Stream.runCollect(exportDataset(beacon).pipe(Stream.map(toNdjsonLine)))
  return Array.from(lines).join("")
})

export const registerReflexRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/reflex/export", async (c) => {
    const result = await runEffect(
      exportNdjson.pipe(
        Effect.map((text): Exported => ({ ok: true, text })),
        Effect.catch((error) =>
          failureResponse(error).pipe(Effect.map((response): Exported => ({ ok: false, response }))),
        ),
      ),
    )
    return result.ok
      ? c.body(result.text, 200, { "content-type": "application/x-ndjson" })
      : sendResponse(c, result.response)
  })
}
