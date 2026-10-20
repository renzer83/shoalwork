import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { InlineKeyboard } from "grammy"
import { describe, expect } from "vitest"
import { makeTelegramOut } from "../../src/telegram/out.js"
import { DEV_DEF, FORUM_CHAT, makeFakeTelegram, TestLayer } from "../support.js"

const setup = () =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const dev = yield* registry.upsert(DEV_DEF, "test")
    const fake = makeFakeTelegram()
    const out = makeTelegramOut({
      api: fake.api,
      forumChatId: FORUM_CHAT,
      sql: yield* SqlClient,
      beacon: yield* Beacon,
      registry,
    })
    return { dev, fake, out }
  })

describe("TelegramOut html and message references", () => {
  it.effect("sends already-escaped text as is when html is set", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      yield* out.send(dev.id, "<b>Nome</b>: &amp; ok", { html: true })
      expect(fake.sent[0]?.text).toBe("<b>Nome</b>: &amp; ok")
      expect(fake.sent[0]?.other).toMatchObject({ parse_mode: "HTML" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("still escapes the text when html is not set", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      yield* out.send(dev.id, "<b>x</b>", {})
      expect(fake.sent[0]?.text).toBe("&lt;b&gt;x&lt;/b&gt;")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("sendRef returns the reference of the message that carries the keyboard", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      const ref = yield* out.sendRef(dev.id, "pergunta", {
        replyMarkup: new InlineKeyboard().text("ok", "ok"),
      })
      expect(ref).toEqual({ chatId: FORUM_CHAT, messageId: fake.sent.length })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("sendRef returns undefined and sends nothing for blank text", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      const ref = yield* out.sendRef(dev.id, "   ")
      expect(ref).toBeUndefined()
      expect(fake.sent).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("editReplyMarkup with null removes the keyboard (empty edit)", () =>
    Effect.gen(function* () {
      const { out, fake } = yield* setup()
      yield* out.editReplyMarkup({ chatId: FORUM_CHAT, messageId: 9 }, null)
      expect(fake.edits).toEqual([{ chatId: FORUM_CHAT, messageId: 9, other: {} }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("editReplyMarkup with a keyboard replaces it", () =>
    Effect.gen(function* () {
      const { out, fake } = yield* setup()
      const keyboard = new InlineKeyboard().text("ok", "ok")
      yield* out.editReplyMarkup({ chatId: FORUM_CHAT, messageId: 9 }, keyboard)
      expect(fake.edits[0]?.other).toEqual({ reply_markup: keyboard })
    }).pipe(Effect.provide(TestLayer)),
  )
})
