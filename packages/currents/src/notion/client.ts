import { Client, isHTTPResponseError } from "@notionhq/client"
import { Clock, Context, Data, Duration, Effect, Layer, Redacted, Semaphore } from "effect"

// The API version every request is sent with (the SDK default is older).
export const NOTION_VERSION = "2026-03-11"
// Notion allows about 3 requests per second; this connector leaves at least 500 ms between two requests (2 rps).
export const RATE_INTERVAL_MS = 500
// A 429 is retried this many times; the wait is its Retry-After, or this default when the answer has none.
export const MAX_RATE_RETRIES = 3
export const DEFAULT_RETRY_AFTER_MS = 1000

// A failed call. The message names the operation and the HTTP status only: never the body, never the token.
export class NotionError extends Data.TaggedError("NotionError")<{
  readonly op: string
  readonly message: string
}> {}

// What the transport reports for a failed call: the HTTP status (0 when no answer came) and the Retry-After delay.
export class NotionHttpError extends Data.TaggedError("NotionHttpError")<{
  readonly status: number
  readonly retryAfterMs: number | undefined
}> {}

export interface NotionRequest {
  // Names the call in errors, e.g. "search" or "page.create".
  readonly op: string
  readonly method: "get" | "post" | "patch"
  // Relative to the API version root, e.g. "search" or "pages/<id>". Ids are checked by the caller.
  readonly path: string
  readonly body?: Record<string, unknown> | undefined
}

// The only way out to the network. The SDK adapter below is the production one; tests pass a fake.
export interface NotionTransport {
  readonly send: (request: NotionRequest) => Effect.Effect<unknown, NotionHttpError>
}

export interface NotionShape {
  readonly request: (request: NotionRequest) => Effect.Effect<unknown, NotionError>
}

export class Notion extends Context.Service<Notion, NotionShape>()("@shoalwork/Notion") {}

const failureMessage = (op: string, status: number): string => {
  if (status === 0) return `${op} failed`
  if (status === 429) return `${op} rate limited`
  return `${op} failed with HTTP ${status}`
}

// Rate limit and retry on top of any transport. Every attempt takes the next start slot, so requests leave at least
// RATE_INTERVAL_MS apart; a 429 waits its Retry-After and tries again, up to MAX_RATE_RETRIES times.
export const makeNotion = (transport: NotionTransport): NotionShape => {
  const gate = Semaphore.makeUnsafe(1)
  let nextSlot = 0
  // Returns how long this attempt must wait before it leaves. The slot is booked under the gate, the wait is outside it.
  const bookSlot: Effect.Effect<number> = gate.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const start = Math.max(now, nextSlot)
      nextSlot = start + RATE_INTERVAL_MS
      return start - now
    }),
  )

  const attempt = (request: NotionRequest, tries: number): Effect.Effect<unknown, NotionError> =>
    Effect.gen(function* () {
      const wait = yield* bookSlot
      if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
      return yield* transport.send(request)
    }).pipe(
      Effect.catchTag("NotionHttpError", (error): Effect.Effect<unknown, NotionError> => {
        if (error.status === 429 && tries < MAX_RATE_RETRIES) {
          const wait = error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
          return Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(attempt(request, tries + 1)))
        }
        return Effect.fail(
          new NotionError({ op: request.op, message: failureMessage(request.op, error.status) }),
        )
      }),
    )

  return { request: (request) => attempt(request, 0) }
}

// Production transport: the official SDK, with its own retries off (makeNotion owns the 429 policy).
export type NotionFetch = NonNullable<NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"]>

export interface NotionTransportOptions {
  // Injected by tests so that no request leaves the process.
  readonly fetch?: NotionFetch | undefined
}

// Retry-After is either a number of seconds or an HTTP date. Headers come from the fetch of the SDK (a Headers object).
const retryAfterOf = (headers: unknown): string | undefined => {
  if (headers instanceof Headers) return headers.get("retry-after") ?? undefined
  return undefined
}

export const retryAfterMsOf = (headers: unknown): number | undefined => {
  const value = retryAfterOf(headers)
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (value.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

const httpErrorOf = (cause: unknown): NotionHttpError =>
  isHTTPResponseError(cause)
    ? new NotionHttpError({ status: cause.status, retryAfterMs: retryAfterMsOf(cause.headers) })
    : new NotionHttpError({ status: 0, retryAfterMs: undefined })

export const notionTransport = (
  token: Redacted.Redacted<string>,
  options: NotionTransportOptions = {},
): NotionTransport => {
  const client = new Client({
    auth: Redacted.value(token),
    notionVersion: NOTION_VERSION,
    retry: false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  return {
    send: (request) =>
      Effect.tryPromise({
        try: () =>
          client.request<Record<string, unknown>>({
            path: request.path,
            method: request.method,
            ...(request.body === undefined ? {} : { body: request.body }),
          }),
        catch: httpErrorOf,
      }),
  }
}

export interface NotionConfig {
  // Read from the Vault by the composition root (T-064); never logged, never in an event.
  readonly token: Redacted.Redacted<string>
}

export const NotionLive = (config: NotionConfig): Layer.Layer<Notion> =>
  Layer.succeed(Notion, makeNotion(notionTransport(config.token)))
