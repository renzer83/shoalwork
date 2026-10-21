import { randomUUID } from "node:crypto"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type Bot, BotId, NotFound, streamIds, TimelinePage } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Hono } from "hono"
import { type Cursor, readTimeline, TEXT_MAX } from "./messages-timeline.js"
import { failureResponse, type RouteResponse, type RunEffect } from "./respond.js"

// The app's chat (T-113). The operator behind the API token is the only user of this channel.
const APP_USER = "user:app"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_DELTA = 500

export const NewMessageBody = Schema.Struct({
  // A Bot id or a Bot name (the apps open the chat of "lead").
  botId: Schema.String.check(Schema.isMinLength(1)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TEXT_MAX)),
})

// 202 is not in the shared RouteStatus: the answer says "accepted", the Bot replies through the Beacon later.
type Answer = { readonly status: 202; readonly body: unknown } | RouteResponse

const resolveBot = (idOrName: string): Effect.Effect<Bot, NotFound | SqlError, BotRegistry> =>
  Effect.gen(function* () {
    const bots = yield* BotRegistry
    if (idOrName.startsWith("bot_")) {
      const id = yield* Schema.decodeUnknownEffect(BotId)(idOrName).pipe(
        Effect.mapError(() => new NotFound({ entity: "Bot", id: idOrName })),
      )
      return yield* bots.get(id)
    }
    return yield* bots.getByName(idOrName)
  })

const postMessage = (raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(NewMessageBody)(raw)
    if (body.text.trim() === "") {
      return { status: 400, body: { error: "invalid request", where: "text" } } satisfies Answer
    }
    const bot = yield* resolveBot(body.botId)
    const beacon = yield* Beacon
    const event = yield* beacon.append({
      streamId: streamIds.bot(bot.id),
      type: "message.inbound",
      payload: { channel: "app", userId: APP_USER, text: body.text, botId: bot.id },
      actor: APP_USER,
      correlationId: randomUUID(),
    })
    return { status: 202, body: { eventId: event.id } } satisfies Answer
  })

const intParam = (raw: string | undefined): number | undefined | "invalid" => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : "invalid"
}

const invalid = (param: string): Answer => ({ status: 400, body: { error: "invalid query", param } })

const getMessages = (params: {
  readonly botId: string | undefined
  readonly before: string | undefined
  readonly after: string | undefined
  readonly limit: string | undefined
}) =>
  Effect.gen(function* () {
    if (params.botId === undefined || params.botId === "") return invalid("botId")
    const before = intParam(params.before)
    const after = intParam(params.after)
    const limit = intParam(params.limit)
    if (before === "invalid") return invalid("before")
    if (after === "invalid") return invalid("after")
    if (limit === "invalid" || limit === 0) return invalid("limit")
    if (before !== undefined && after !== undefined) return invalid("after")
    const bot = yield* resolveBot(params.botId)
    const cursor: Cursor =
      after === undefined
        ? { mode: "before", before: before ?? Number.MAX_SAFE_INTEGER }
        : { mode: "after", after }
    const cap = cursor.mode === "after" ? MAX_DELTA : MAX_LIMIT
    const page = yield* readTimeline(bot.id, cursor, Math.min(limit ?? DEFAULT_LIMIT, cap))
    // Checks the shape the apps decode; the page is built from decoded payloads, so a failure is a bug here.
    const checked = yield* Schema.decodeUnknownEffect(TimelinePage)(page).pipe(Effect.orDie)
    const encoded = yield* Schema.encodeEffect(TimelinePage)(checked).pipe(Effect.orDie)
    return { status: 200, body: encoded } satisfies Answer
  })

export const registerMessageRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.post("/messages", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    const answer: Answer = await runEffect(postMessage(raw).pipe(Effect.catch(failureResponse)))
    return c.json(answer.body, answer.status)
  })

  app.get("/messages", async (c) => {
    const answer: Answer = await runEffect(
      getMessages({
        botId: c.req.query("botId"),
        before: c.req.query("before"),
        after: c.req.query("after"),
        limit: c.req.query("limit"),
      }).pipe(Effect.catch(failureResponse)),
    )
    return c.json(answer.body, answer.status)
  })
}
