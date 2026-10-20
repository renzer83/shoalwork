import { it } from "@effect/vitest"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { streamIds } from "@shoalwork/contracts"
import { Context, Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { HttpError } from "grammy"
import type { Update } from "grammy/types"
import { describe, expect, vi } from "vitest"
import { createTelegramBot, installInbound, reportBotError } from "../../src/telegram/bot.js"
import { makeTelegramOut } from "../../src/telegram/out.js"
import {
  ALLOWED_USER,
  BOT_INFO,
  DEV_DEF,
  FORUM_CHAT,
  LEAD_DEF,
  makeFakeTelegram,
  STRANGER,
  TestLayer,
  TOKEN,
} from "../support.js"

const GROUP_CHAT = -1009999999

// A text update from a private chat, the forum chat (with a topic thread), or any other chat.
const textUpdate = (fields: {
  readonly from: number
  readonly text: string
  readonly threadId?: number
  readonly chatId?: number
}): Update => ({
  update_id: 1,
  message: {
    message_id: 1,
    date: 1_800_000_000,
    chat:
      fields.chatId !== undefined
        ? { id: fields.chatId, type: "supergroup", title: "other", is_forum: true }
        : fields.threadId === undefined
          ? { id: fields.from, type: "private", first_name: "Renan" }
          : { id: Number(FORUM_CHAT), type: "supergroup", title: "shoal", is_forum: true },
    from: { id: fields.from, is_bot: false, first_name: "Renan" },
    text: fields.text,
    ...(fields.threadId === undefined ? {} : { message_thread_id: fields.threadId, is_topic_message: true }),
  },
})

const eventsOf = (type: "message.inbound" | "error.raised") =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return Array.from(yield* Stream.runCollect(beacon.readAll(0, [type])))
  })

// Real grammY Bot with a fake botInfo: handleUpdate runs the middlewares without any call to Telegram.
const setup = (beaconOverride?: BeaconShape) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const lead = yield* registry.upsert(LEAD_DEF, "test")
    const dev = yield* registry.upsert(DEV_DEF, "test")
    const fake = makeFakeTelegram()
    const out = makeTelegramOut({
      api: fake.api,
      forumChatId: FORUM_CHAT,
      sql: yield* SqlClient,
      beacon: yield* Beacon,
      registry,
    })
    const devTopic = yield* out.ensureTopic(dev)
    const bot = createTelegramBot(TOKEN, { botInfo: BOT_INFO })
    const beacon = beaconOverride ?? (yield* Beacon)
    const context = Context.add(yield* Effect.context<Beacon | BotRegistry | SqlClient>(), Beacon, beacon)
    installInbound(bot, { allowedUserIds: new Set([ALLOWED_USER]), forumChatId: FORUM_CHAT, context })
    return { bot, lead, dev, devTopic }
  })

describe("inbound Telegram messages", () => {
  it.effect("drops a message from a user outside the allowlist without an event", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() => bot.handleUpdate(textUpdate({ from: STRANGER, text: "oi" })))
      expect(yield* eventsOf("message.inbound")).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops a message from another group chat without an event", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(textUpdate({ from: ALLOWED_USER, text: "oi", chatId: GROUP_CHAT, threadId: 5 })),
      )
      expect(yield* eventsOf("message.inbound")).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("maps a message in a Bot's topic to that Bot's id and stream", () =>
    Effect.gen(function* () {
      const { bot, dev, devTopic } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(textUpdate({ from: ALLOWED_USER, text: "status?", threadId: devTopic.threadId })),
      )
      const events = yield* eventsOf("message.inbound")
      expect(events).toHaveLength(1)
      const [event] = events
      expect(event?.streamId).toBe(streamIds.bot(dev.id))
      expect(event?.payload).toMatchObject({
        channel: "telegram",
        chatId: FORUM_CHAT,
        threadId: String(devTopic.threadId),
        userId: String(ALLOWED_USER),
        text: "status?",
        botId: dev.id,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("sends a private message to the lead", () =>
    Effect.gen(function* () {
      const { bot, lead } = yield* setup()
      yield* Effect.promise(() => bot.handleUpdate(textUpdate({ from: ALLOWED_USER, text: "oi" })))
      const [event] = yield* eventsOf("message.inbound")
      expect(event?.streamId).toBe(streamIds.bot(lead.id))
      expect(event?.payload).toMatchObject({ botId: lead.id, text: "oi" })
      expect(event?.payload).not.toHaveProperty("threadId")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("sends a message from a thread that no Bot owns to the lead", () =>
    Effect.gen(function* () {
      const { bot, lead } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(textUpdate({ from: ALLOWED_USER, text: "x", threadId: 9999 })),
      )
      const [event] = yield* eventsOf("message.inbound")
      expect(event?.payload).toMatchObject({ botId: lead.id, threadId: "9999" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failing inbound append becomes one error.raised event with the redacted reason", () =>
    Effect.gen(function* () {
      const real = yield* Beacon
      const flaky: BeaconShape = {
        ...real,
        append: (e, opts) =>
          e.type === "message.inbound" ? Effect.die(new Error("disk full")) : real.append(e, opts),
      }
      const { bot } = yield* setup(flaky)
      yield* Effect.promise(() => bot.handleUpdate(textUpdate({ from: ALLOWED_USER, text: "oi" })))
      const raised = yield* eventsOf("error.raised")
      expect(raised).toHaveLength(1)
      expect(raised[0]?.payload).toMatchObject({ where: "telegram.inbound", message: "disk full" })
      expect(yield* eventsOf("message.inbound")).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a handler error is logged and recorded without the token, even when nested", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: Array<unknown>) => {
          logs.push(args.map(String).join(" "))
        }),
      )
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        yield* reportBotError(
          new HttpError(
            "Network request for 'getUpdates' failed!",
            new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`),
          ),
        )
        const raised = yield* eventsOf("error.raised")
        expect(raised).toHaveLength(1)
        expect(raised[0]?.payload).toMatchObject({ where: "telegram.handler" })
        const everything = [
          ...logs,
          ...stdout.mock.calls.map((call) => String(call[0])),
          ...stderr.mock.calls.map((call) => String(call[0])),
          JSON.stringify(raised),
        ].join("\n")
        expect(everything).not.toContain("fake-token")
        expect(everything).toContain("bot<redacted>")
      } finally {
        for (const spy of spies) {
          spy.mockRestore()
        }
        stdout.mockRestore()
        stderr.mockRestore()
      }
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the bot installs the auto-retry transformer on its api", () =>
    Effect.sync(() => {
      const bot = createTelegramBot(TOKEN, { botInfo: BOT_INFO })
      expect(bot.api.config.installedTransformers()).toHaveLength(1)
    }),
  )
})
