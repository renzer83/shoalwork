import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { BotId } from "@shoalwork/contracts"
import { ExecutorRegistry } from "@shoalwork/executors"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Conversation } from "../src/conversation.js"
import { factsFor } from "../src/conversation-context.js"
import { createBots, harness, inbound } from "./conversation-support.js"
import { allEvents } from "./support.js"

const CODE_TASK = "implementa a issue 3 no repo X"

// The Bot is archived through the registry, as POST /bots/:id/archive does.
const archive = (botId: BotId) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    yield* registry.setState(botId, "archived", undefined, "user:app")
  })

const taskBotIds = (events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>) =>
  events
    .filter((event) => event.type === "task.received")
    .map((event) => (event.payload as { readonly task: { readonly botId: string } }).task.botId)

describe("an archived Bot as the owner of a message", () => {
  it.effect("is left out of the Bots the rules see", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { lead, dev } = yield* createBots
      yield* archive(dev.id)
      const event = yield* inbound(lead, CODE_TASK)
      const facts = yield* factsFor(
        {
          beacon: yield* Beacon,
          bots: yield* BotRegistry,
          executors: yield* ExecutorRegistry,
        },
        event,
        CODE_TASK,
        "1",
        undefined,
      )
      expect(facts.bots.map((bot) => bot.id)).toEqual([lead.id])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("gets no message and no task when the rules would have sent the work to it", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { lead, dev } = yield* createBots
      yield* archive(dev.id)
      const conversation = yield* Conversation
      yield* conversation.onInbound(yield* inbound(lead, CODE_TASK))
      expect(h.telegram.sent.some((message) => message.text.includes("worker-bot"))).toBe(false)
      expect(taskBotIds(Array.from(yield* allEvents))).not.toContain(dev.id)
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("control: the same message goes to the developer Bot while it is not archived", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { lead, dev } = yield* createBots
      const conversation = yield* Conversation
      yield* conversation.onInbound(yield* inbound(lead, CODE_TASK))
      expect(h.telegram.sent.some((message) => message.text.includes("worker-bot"))).toBe(true)
      expect(taskBotIds(Array.from(yield* allEvents))).toContain(dev.id)
    }).pipe(Effect.provide(h.layer))
  })
})
