import { BotRegistry } from "@shoalwork/bots"
import { NotFound } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Path segment for GET /bots/:idOrName: a value starting with bot_ is an id, anything else is a name.
const isBotIdShaped = (value: string): boolean => value.startsWith("bot_")

const listBots = Effect.gen(function* () {
  const registry = yield* BotRegistry
  const bots = yield* registry.list()
  const summaries = bots.map((bot) => ({ id: bot.id, name: bot.name, role: bot.role, state: bot.state }))
  return { status: 200, body: { bots: summaries } } satisfies RouteResponse
}).pipe(Effect.catch(failureResponse))

const readBot = (idOrName: string) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const bots = yield* registry.list()
    const found = isBotIdShaped(idOrName)
      ? bots.find((bot) => bot.id === idOrName)
      : bots.find((bot) => bot.name === idOrName)
    if (found === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Bot", id: idOrName }))
    }
    const summary = { id: found.id, name: found.name, role: found.role, state: found.state }
    return { status: 200, body: { bot: summary } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerBotRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/bots", async (c) => sendResponse(c, await runEffect(listBots)))

  app.get("/bots/:idOrName", async (c) => sendResponse(c, await runEffect(readBot(c.req.param("idOrName")))))
}
