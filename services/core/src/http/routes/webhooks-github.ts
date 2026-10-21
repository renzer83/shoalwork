import { createHash, randomUUID } from "node:crypto"
import { Beacon } from "@shoalwork/beacon"
import { streamIds } from "@shoalwork/contracts"
import {
  claimDelivery,
  type GithubReduction,
  type InstallationChange,
  installationEventPayload,
  isInstallationEvent,
  parseInstallation,
  recordInstallation,
  reduceGithubDelivery,
  verifyGithubSignature,
} from "@shoalwork/currents"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Hono } from "hono"
import {
  declaredLength,
  type ErrorLimiter,
  GITHUB_BODY_LIMIT_BYTES,
  makeErrorLimiter,
  readBounded,
} from "../webhook-guard.js"
import type { RunEffect } from "./respond.js"

export const GITHUB_WEBHOOK_PATH = "/webhooks/github"
// A GitHub delivery id is a UUID; anything else is refused before it reaches the log.
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/
const ERROR_WHERE = "webhook.github"

type WebhookStatus = 200 | 400 | 401 | 413 | 500 | 503

export interface WebhookResponse {
  readonly status: WebhookStatus
  readonly body: Record<string, unknown>
}

export interface WebhookHeaders {
  readonly signature: string | undefined
  readonly event: string | undefined
  readonly delivery: string | undefined
}

export interface WebhookContext {
  // GITHUB_WEBHOOK_SECRET; undefined answers 503 to everything.
  readonly secret: Redacted.Redacted<string> | undefined
  readonly limiter: ErrorLimiter
  readonly now: Date
}

// A refusal is logged every time, and recorded as error.raised at most once per tag per window. The correlation id is
// random until the request is authenticated: an unauthenticated header is never copied into the log.
const refusal = (
  ctx: WebhookContext,
  tag: string,
  message: string,
  correlationId: string,
): Effect.Effect<void, never, Beacon> =>
  Effect.gen(function* () {
    const admission = ctx.limiter.admit(tag, ctx.now.getTime())
    yield* Effect.logWarning(`github webhook refused: ${tag}`)
    if (!admission.record) return
    const beacon = yield* Beacon
    const text =
      admission.suppressed > 0 ? `${message} (${admission.suppressed} more in the last window)` : message
    yield* beacon.append({
      streamId: streamIds.system,
      type: "error.raised",
      payload: { where: ERROR_WHERE, tag, message: text },
      actor: "system:github",
      correlationId,
    })
  }).pipe(Effect.catch((error) => Effect.logError("github webhook failure not recorded", error._tag)))

const refuse = (
  ctx: WebhookContext,
  status: 400 | 401 | 413 | 503,
  tag: string,
  message: string,
): Effect.Effect<WebhookResponse, never, Beacon> =>
  refusal(ctx, tag, message, randomUUID()).pipe(Effect.as({ status, body: { error: message } }))

type Reduced =
  | { readonly _tag: "ok"; readonly reduction: GithubReduction }
  | { readonly _tag: "invalid"; readonly message: string }

// A payload that does not match its shape is a refusal (400), never a crash.
const reduceOrFail = (event: string, text: string, delivery: string): Effect.Effect<Reduced> =>
  reduceGithubDelivery(event, text, delivery).pipe(
    Effect.map((reduction): Reduced => ({ _tag: "ok", reduction })),
    Effect.catch((error) => Effect.succeed<Reduced>({ _tag: "invalid", message: error.message })),
  )

// installation and installation_repositories keep github_installations in step (T-084). Same order: the claim and the
// row write share one transaction, so a failed write gives the claim back and the redelivery is applied.
const handleInstallation = (
  ctx: WebhookContext,
  body: Uint8Array,
  headers: WebhookHeaders,
  delivery: string,
): Effect.Effect<WebhookResponse, never, Beacon | SqlClient> =>
  Effect.gen(function* () {
    const event = headers.event ?? ""
    const parsed = yield* parseInstallation(event, new TextDecoder().decode(body)).pipe(
      Effect.map((change): { readonly _tag: "ok"; readonly change: InstallationChange } => ({
        _tag: "ok",
        change,
      })),
      Effect.catch((error) => Effect.succeed({ _tag: "invalid" as const, message: error.message })),
    )
    if (parsed._tag === "invalid") {
      return yield* refuse(ctx, 400, "InvalidPayload", parsed.message)
    }
    if (parsed.change._tag === "ignored") {
      return { status: 200, body: { ok: true, ignored: parsed.change.name } }
    }
    const signatureHash = createHash("sha256")
      .update(headers.signature ?? "")
      .digest("hex")
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const change = parsed.change
    // Claim, row and github.installation event commit together: a repeat delivery appends nothing.
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const fresh = yield* claimDelivery(sql, delivery, event, signatureHash, ctx.now)
          if (!fresh) return "duplicate" as const
          yield* recordInstallation(sql, change)
          yield* beacon.append({
            streamId: streamIds.system,
            type: "github.installation",
            payload: installationEventPayload(change, delivery),
            actor: "system:github",
            correlationId: delivery,
          })
          return "recorded" as const
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logError("installation not recorded", error._tag).pipe(Effect.as("failed" as const)),
        ),
      )
    if (outcome === "failed") {
      yield* refusal(ctx, "RecordFailed", "installation could not be recorded", delivery)
      return { status: 500, body: { error: "installation not recorded" } }
    }
    if (outcome === "duplicate") {
      return { status: 200, body: { ok: true, duplicate: true } }
    }
    return { status: 200, body: { ok: true, type: event } }
  })

// Order: secret, signature, headers, payload shape, one transaction for claim and event, then the answer.
// Unsupported events answer 200 and record nothing.
export const handleGithubWebhook = (
  ctx: WebhookContext,
  body: Uint8Array,
  headers: WebhookHeaders,
): Effect.Effect<WebhookResponse, never, Beacon | SqlClient> =>
  Effect.gen(function* () {
    if (ctx.secret === undefined) {
      return yield* refuse(ctx, 503, "NotConfigured", "webhook secret is not set")
    }
    if (!verifyGithubSignature(Redacted.value(ctx.secret), body, headers.signature)) {
      return yield* refuse(ctx, 401, "SignatureInvalid", "signature does not match the body")
    }
    // Authenticated from here on: the delivery header is trusted enough to be the correlation id.
    if (headers.event === undefined) {
      return yield* refuse(ctx, 400, "MissingEvent", "X-GitHub-Event is missing")
    }
    const delivery = headers.delivery
    if (delivery === undefined || !DELIVERY_ID.test(delivery)) {
      return yield* refuse(ctx, 400, "MissingDelivery", "X-GitHub-Delivery is missing or malformed")
    }
    if (isInstallationEvent(headers.event)) {
      return yield* handleInstallation(ctx, body, headers, delivery)
    }
    const reduced: Reduced = yield* reduceOrFail(headers.event, new TextDecoder().decode(body), delivery)
    if (reduced._tag === "invalid") {
      return yield* refuse(ctx, 400, "InvalidPayload", reduced.message)
    }
    if (reduced.reduction._tag === "ignored") {
      return { status: 200, body: { ok: true, ignored: reduced.reduction.name } }
    }
    const { event } = reduced.reduction
    const signatureHash = createHash("sha256")
      .update(headers.signature ?? "")
      .digest("hex")
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    // Claim and event commit together: a failed append gives the claim back, so the redelivery is processed.
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const fresh = yield* claimDelivery(sql, delivery, headers.event ?? "", signatureHash, ctx.now)
          if (!fresh) return "duplicate" as const
          yield* beacon.append({
            streamId: streamIds.system,
            type: event.type,
            payload: event.payload,
            actor: event.actor,
            correlationId: delivery,
          })
          return "recorded" as const
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logError("github event not recorded", error._tag).pipe(Effect.as("failed" as const)),
        ),
      )
    if (outcome === "failed") {
      yield* refusal(ctx, "RecordFailed", "event could not be recorded", delivery)
      return { status: 500, body: { error: "event not recorded" } }
    }
    if (outcome === "duplicate") {
      return { status: 200, body: { ok: true, duplicate: true } }
    }
    return { status: 200, body: { ok: true, type: event.type } }
  })

// Mounts POST /webhooks/github. HMAC authenticates it, not the bearer token: app.ts exempts this path.
// Order before any read: secret (503), Content-Length (400 invalid, 413 too large), then the body streamed with the
// same ceiling (413). The limiter lives as long as the registration.
export const registerGithubWebhookRoutes = (
  app: Hono,
  runEffect: RunEffect,
  secret: Redacted.Redacted<string> | undefined,
): void => {
  const limiter = makeErrorLimiter()
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    const ctx: WebhookContext = { secret, limiter, now: new Date() }
    const respond = async (response: WebhookResponse) => c.json(response.body, response.status)
    if (secret === undefined) {
      return respond(await runEffect(refuse(ctx, 503, "NotConfigured", "webhook secret is not set")))
    }
    const declared = declaredLength(c.req.header("content-length"))
    if (declared === "invalid") {
      return respond(await runEffect(refuse(ctx, 400, "InvalidLength", "Content-Length is not a number")))
    }
    if (typeof declared === "number" && declared > GITHUB_BODY_LIMIT_BYTES) {
      return respond(await runEffect(refuse(ctx, 413, "PayloadTooLarge", "payload too large")))
    }
    const body = await readBounded(c.req.raw.body, GITHUB_BODY_LIMIT_BYTES)
    if (body === undefined) {
      return respond(await runEffect(refuse(ctx, 413, "PayloadTooLarge", "payload too large")))
    }
    const response = await runEffect(
      handleGithubWebhook(ctx, body, {
        signature: c.req.header("x-hub-signature-256"),
        event: c.req.header("x-github-event"),
        delivery: c.req.header("x-github-delivery"),
      }),
    )
    return respond(response)
  })
}
