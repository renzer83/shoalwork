import { type Event, Event as EventSchema, type EventType, SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { ApiClient } from "./client.js"
import { HttpError } from "./errors.js"

export interface SseFrame {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

const FRAME_END = /\r\n\r\n|\n\n|\r\r/

const parseFrame = (block: string): SseFrame | undefined => {
  let id: string | undefined
  let event: string | undefined
  const data: Array<string> = []
  for (const line of block.split(/\r\n|\n|\r/)) {
    // A line starting with ":" is a comment (the server's ": ping" heartbeat).
    if (line === "" || line.startsWith(":")) {
      continue
    }
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? "" : line.slice(colon + 1)
    const value = raw.startsWith(" ") ? raw.slice(1) : raw
    if (field === "id") {
      id = value
    } else if (field === "event") {
      event = value
    } else if (field === "data") {
      data.push(value)
    }
  }
  return id === undefined && event === undefined && data.length === 0
    ? undefined
    : { id, event, data: data.join("\n") }
}

// A frame is one event; a server that never sends the blank line must not make the buffer grow without bound.
export const MAX_BUFFER_BYTES = 1024 * 1024

// Splits a text/event-stream byte stream into frames. Ends when the stream ends or the reader is cancelled.
// Throws HttpError (status 0) when the unfinished part of a frame passes MAX_BUFFER_BYTES.
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let match = FRAME_END.exec(buffer)
      while (match !== null) {
        const frame = parseFrame(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
        if (frame !== undefined) {
          yield frame
        }
        match = FRAME_END.exec(buffer)
      }
      if (buffer.length > MAX_BUFFER_BYTES) {
        throw new HttpError({ status: 0, body: `event frame larger than ${MAX_BUFFER_BYTES} bytes` })
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export interface SubscribeOptions {
  readonly types?: ReadonlyArray<EventType>
  readonly lastEventId?: number
  readonly signal: AbortSignal
  // Frames or connections that failed; the stream carries on (a bad frame never stops the feed).
  readonly onError?: (error: HttpError | SchemaViolation) => void
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
}

const decodeEvent = Schema.decodeUnknownEffect(EventSchema)

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

// A 4xx other than 408/429 will not get better by retrying (bad token, bad query).
const retryable = (error: HttpError): boolean =>
  error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 429

// GET /events/live as an async iterable. Reconnects with Last-Event-ID after a 2 s pause (doubling to 30 s).
export async function* subscribeEvents(
  client: ApiClient,
  opts: SubscribeOptions,
): AsyncGenerator<Event, void, undefined> {
  const initial = opts.initialDelayMs ?? 2_000
  const max = opts.maxDelayMs ?? 30_000
  let delay = initial
  let lastId = opts.lastEventId
  const path = `/events/live${opts.types === undefined ? "" : `?types=${opts.types.join(",")}`}`
  while (!opts.signal.aborted) {
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (lastId !== undefined) {
      headers["last-event-id"] = String(lastId)
    }
    const opened = await Effect.runPromise(
      client.send("GET", path, { headers, signal: opts.signal }).pipe(Effect.result),
    )
    if (opened._tag === "Failure") {
      if (opts.signal.aborted) {
        return
      }
      opts.onError?.(opened.failure)
      if (!retryable(opened.failure)) {
        throw opened.failure
      }
    } else if (!opened.success.ok || opened.success.body === null) {
      const error = new HttpError({
        status: opened.success.status,
        body: await opened.success.text().catch(() => ""),
      })
      await opened.success.body?.cancel().catch(() => undefined)
      opts.onError?.(error)
      if (!retryable(error)) {
        throw error
      }
    } else {
      try {
        for await (const frame of readFrames(opened.success.body)) {
          delay = initial
          if (frame.id !== undefined) {
            const position = Number(frame.id)
            if (Number.isSafeInteger(position)) {
              lastId = position
            }
          }
          if (frame.data === "") {
            continue
          }
          const decoded = await Effect.runPromise(
            Effect.try({ try: () => JSON.parse(frame.data) as unknown, catch: () => frame.data }).pipe(
              Effect.flatMap((json) => decodeEvent(json)),
              Effect.mapError((issue) => new SchemaViolation({ where: "GET /events/live", issue })),
              Effect.result,
            ),
          )
          if (decoded._tag === "Success") {
            yield decoded.success
          } else {
            opts.onError?.(decoded.failure)
          }
        }
      } catch (cause) {
        // A read that fails after an abort is the caller leaving; any other failure is a dropped connection.
        if (opts.signal.aborted) {
          return
        }
        opts.onError?.(
          new HttpError({ status: 0, body: cause instanceof Error ? cause.message : String(cause) }),
        )
      }
    }
    await sleep(delay, opts.signal)
    delay = Math.min(delay * 2, max)
  }
}
