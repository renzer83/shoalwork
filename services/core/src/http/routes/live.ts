import { Beacon } from "@shoalwork/beacon"
import { Event, EventType } from "@shoalwork/contracts"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import type { Hono } from "hono"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import type { RunEffect } from "./respond.js"

// Comment lines keep idle connections open through proxies and the browser.
export const HEARTBEAT_MS = 15_000

const encodeEvent = Schema.encodeSync(Event)

type ParsedTypes =
  | { readonly ok: true; readonly types: ReadonlyArray<EventType> | undefined }
  | { readonly ok: false }

// Same comma-separated `types` syntax as GET /events.
const parseTypes = (raw: string | undefined): ParsedTypes => {
  if (raw === undefined) {
    return { ok: true, types: undefined }
  }
  const types: Array<EventType> = []
  for (const name of raw.split(",").map((part) => part.trim())) {
    if (!Schema.is(EventType)(name)) {
      return { ok: false }
    }
    types.push(name)
  }
  return { ok: true, types }
}

// Last-Event-ID is the position of the last event the client saw. Absent or empty means "from the start".
const parseCursor = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") {
    return 0
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

// Subscribe before reading history: an event committed in between shows up in both. The cursor drops the
// live copy, so each event is sent once and none is lost.
const attach = (types: ReadonlyArray<EventType> | undefined, after: number) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const live = yield* beacon.subscribe(types)
    const history = yield* Stream.runCollect(beacon.readAll(after, types)).pipe(Effect.orDie)
    return { live, history }
  })

const sendEvent = (stream: SSEStreamingApi, event: Event): Promise<void> =>
  stream.writeSSE({ id: String(event.position), event: event.type, data: JSON.stringify(encodeEvent(event)) })

const pump = async (
  stream: SSEStreamingApi,
  runEffect: RunEffect,
  types: ReadonlyArray<EventType> | undefined,
  after: number,
): Promise<void> => {
  const scope = await runEffect(Scope.make())
  const close = (): Promise<void> => runEffect(Scope.close(scope, Exit.void))
  // Closing the scope ends the subscription, which also ends a loop that is waiting for the next event.
  stream.onAbort(() => {
    void close()
  })
  const timer = setInterval(() => {
    // A failed write means the client is gone; onAbort releases the subscription.
    stream.write(": ping\n\n").catch(() => undefined)
  }, HEARTBEAT_MS)
  try {
    const { live, history } = await runEffect(attach(types, after).pipe(Scope.provide(scope)))
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
    // Ending the subscription from onAbort interrupts the pending pull; that is the normal way out.
    if (!stream.aborted) {
      throw cause
    }
  } finally {
    clearInterval(timer)
    await close()
  }
}

export const registerLiveRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/events/live", (c) => {
    const types = parseTypes(c.req.query("types"))
    if (!types.ok) {
      return c.json({ error: "invalid query", param: "types" }, 400)
    }
    const after = parseCursor(c.req.header("last-event-id"))
    if (after === undefined) {
      return c.json({ error: "invalid header", param: "last-event-id" }, 400)
    }
    return streamSSE(c, (stream) => pump(stream, runEffect, types.types, after))
  })
}
