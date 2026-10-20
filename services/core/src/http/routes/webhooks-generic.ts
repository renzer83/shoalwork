import { NotFound, TideId as TideIdSchema } from "@shoalwork/contracts"
import { type TideSkipped, Tides } from "@shoalwork/tides"
import { Effect, Option, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteStatus, type RunEffect } from "./respond.js"

// A webhook body larger than this is refused with 413, and the rest of it is not read.
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024

// These paths sit outside the bearer token: the Tide's secret is their authentication.
export const GENERIC_WEBHOOK_PATH = /^\/webhooks\/generic\/[^/]+$/

const JSON_MEDIA_TYPE = /^application\/json\s*(;|$)/i

interface WebhookResponse {
  readonly status: RouteStatus | 409 | 413 | 415
  readonly body: unknown
}

const UNAUTHORIZED: WebhookResponse = { status: 401, body: { error: "unauthorized" } }

const isJson = (contentType: string | undefined): boolean =>
  contentType !== undefined && JSON_MEDIA_TYPE.test(contentType)

// Reads at most `limit` bytes. Undefined when the body is larger: the reader is cancelled and nothing more is read.
const readLimited = async (request: Request, limit: number): Promise<string | undefined> => {
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) {
    return undefined
  }
  const reader = request.body?.getReader()
  if (reader === undefined) {
    return ""
  }
  const chunks: Array<Uint8Array> = []
  let total = 0
  let next = await reader.read()
  while (!next.done) {
    total += next.value.byteLength
    if (total > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
    next = await reader.read()
  }
  return Buffer.concat(chunks).toString("utf8")
}

const parseJson = Option.liftThrowable((text: string): unknown => JSON.parse(text))

// A malformed id gets the same answer as a wrong secret, and so does an unknown tide: the reply never says which
// tides exist. A disabled tide is reached only with the right secret, and then it answers 404.
const fireGeneric = (rawId: string, presented: string, text: string) =>
  Effect.gen(function* () {
    const tides = yield* Tides
    const id = yield* Schema.decodeUnknownEffect(TideIdSchema)(rawId).pipe(Effect.option)
    if (Option.isNone(id)) {
      return UNAUTHORIZED
    }
    const matched = yield* tides.checkWebhookSecret(id.value, presented)
    if (!matched) {
      return UNAUTHORIZED
    }
    const body = parseJson(text)
    if (Option.isNone(body)) {
      return { status: 400, body: { error: "invalid json" } } satisfies WebhookResponse
    }
    const task = yield* tides.fireFromWebhook(id.value, body.value)
    return { status: 201, body: { task } } satisfies WebhookResponse
  }).pipe(
    Effect.catchTag("TideSkipped", (skipped: TideSkipped) =>
      Effect.succeed({
        status: 409,
        body: { error: "tide skipped", reason: skipped.reason },
      } satisfies WebhookResponse),
    ),
    Effect.catch(failureResponse),
  )

// Rotation answers the new secret once; the previous one stops working at the same moment.
const rotateSecret = (rawId: string) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(TideIdSchema)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Tide", id: rawId })),
    )
    const secret = yield* (yield* Tides).rotateWebhookSecret(id)
    return {
      status: 201,
      body: { tideId: id, path: `/webhooks/generic/${id}`, secret },
    } satisfies WebhookResponse
  }).pipe(Effect.catch(failureResponse))

export const registerGenericWebhookRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.post("/webhooks/generic/:tideId", async (c) => {
    if (!isJson(c.req.header("content-type"))) {
      return c.json({ error: "unsupported media type" }, 415)
    }
    const text = await readLimited(c.req.raw, WEBHOOK_BODY_LIMIT_BYTES)
    if (text === undefined) {
      return c.json({ error: "payload too large" }, 413)
    }
    const presented = c.req.header("x-webhook-secret") ?? ""
    const result = await runEffect(fireGeneric(c.req.param("tideId"), presented, text))
    return c.json(result.body, result.status)
  })
  app.post("/tides/:id/webhook-secret", async (c) => {
    const result = await runEffect(rotateSecret(c.req.param("id")))
    c.header("cache-control", "no-store")
    return c.json(result.body, result.status)
  })
}
