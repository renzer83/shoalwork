import { BotRegistry } from "@shoalwork/bots"
import { NewTide, NotFound, type TideId, TideId as TideIdSchema } from "@shoalwork/contracts"
import { type TideSkipped, Tides } from "@shoalwork/tides"
import { Effect, Schema, Struct } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// A Tide as the API takes it: the Bot by name or id, the Tide itself, enabled unless said otherwise.
const TideBody = Schema.Struct({
  bot: Schema.String,
  ...NewTide.mapFields(Struct.omit(["enabled"])).fields,
  enabled: Schema.optionalKey(Schema.Boolean),
})

const EnableBody = Schema.Struct({ enabled: Schema.Boolean })

// A run answers 201 with the task, or 409 when a paused or over-budget Bot holds the Tide back.
interface RunResponse {
  readonly status: 201 | 409 | 404 | 400 | 500
  readonly body: unknown
}

const botIdOf = (ref: string) =>
  Effect.gen(function* () {
    const bots = yield* (yield* BotRegistry).list()
    const found = bots.find((bot) => bot.id === ref || bot.name === ref)
    if (found === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Bot", id: ref }))
    }
    return found.id
  })

// A malformed id cannot name a stored Tide, so it answers 404 like an unknown one.
const tideIdOf = (raw: string): Effect.Effect<TideId, NotFound> =>
  Schema.decodeUnknownEffect(TideIdSchema)(raw).pipe(
    Effect.mapError(() => new NotFound({ entity: "Tide", id: raw })),
  )

const listTides = (bot: string | undefined) =>
  Effect.gen(function* () {
    const botId = bot === undefined ? undefined : yield* botIdOf(bot)
    const tides = yield* (yield* Tides).list(botId)
    return { status: 200, body: { tides } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const upsertTide = (raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(TideBody)(raw)
    const botId = yield* botIdOf(body.bot)
    const { bot: _bot, enabled, ...tide } = body
    const stored = yield* (yield* Tides).upsert({ ...tide, botId, enabled: enabled ?? true })
    return { status: 201, body: { tide: stored } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const enableTide = (rawId: string, raw: unknown) =>
  Effect.gen(function* () {
    const id = yield* tideIdOf(rawId)
    const body = yield* Schema.decodeUnknownEffect(EnableBody)(raw)
    yield* (yield* Tides).enable(id, body.enabled)
    return { status: 200, body: { ok: true } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const runTide = (rawId: string) =>
  Effect.gen(function* () {
    const id = yield* tideIdOf(rawId)
    const task = yield* (yield* Tides).runNow(id)
    return { status: 201, body: { task } } satisfies RunResponse
  }).pipe(
    Effect.catchTag("TideSkipped", (skipped: TideSkipped) =>
      Effect.succeed({
        status: 409,
        body: { error: "tide skipped", reason: skipped.reason },
      } satisfies RunResponse),
    ),
    Effect.catch(failureResponse),
  )

export const registerTideRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/tides", async (c) => sendResponse(c, await runEffect(listTides(c.req.query("bot")))))
  app.post("/tides", async (c) =>
    sendResponse(c, await runEffect(upsertTide(await c.req.json().catch(() => null)))),
  )
  app.post("/tides/:id/enable", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(enableTide(c.req.param("id"), raw)))
  })
  app.post("/tides/:id/run", async (c) => {
    const result = await runEffect(runTide(c.req.param("id")))
    return c.json(result.body, result.status)
  })
}
