import { it } from "@effect/vitest"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { Conflict, EventId, streamIds } from "@shoalwork/contracts"
import { Clock, DateTime, Effect, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { InlineKeyboard } from "grammy"
import { describe, expect } from "vitest"
import { TelegramError } from "../../src/telegram/errors.js"
import { makeTelegramOut } from "../../src/telegram/out.js"
import { DEV_DEF, FORUM_CHAT, makeFakeTelegram, TestLayer, TOKEN } from "../support.js"

// Shared setup: the dev Bot registered, its topic created, and a service over the fake transport.
const setup = (failSendMessage?: Error) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const dev = yield* registry.upsert(DEV_DEF, "test")
    const fake = makeFakeTelegram(failSendMessage === undefined ? {} : { failSendMessage })
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const out = makeTelegramOut({ api: fake.api, forumChatId: FORUM_CHAT, sql, beacon, registry })
    return { dev, fake, out, beacon }
  })

describe("TelegramOut.send", () => {
  it.effect("escapes HTML and sends to the Bot's topic thread", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      yield* out.send(dev.id, "<b>ok</b> & done")
      expect(fake.sent).toHaveLength(1)
      expect(fake.sent[0]?.text).toBe("&lt;b&gt;ok&lt;/b&gt; &amp; done")
      expect(fake.sent[0]?.other).toMatchObject({ parse_mode: "HTML", message_thread_id: 101 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("splits a long reply by paragraph and attaches the keyboard to the last chunk only", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      const text = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)].join("\n\n")
      yield* out.send(dev.id, text, { replyMarkup: new InlineKeyboard().text("ok", "ok") })
      expect(fake.sent.map((message) => message.text)).toEqual([
        "a".repeat(3000),
        "b".repeat(3000),
        "c".repeat(3000),
      ])
      expect(fake.sent.map((message) => message.other.reply_markup === undefined)).toEqual([
        true,
        true,
        false,
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records message.outbound with latency and the inbound correlation when inReplyTo is given", () =>
    Effect.gen(function* () {
      const { dev, fake, out, beacon } = yield* setup()
      const inbound = yield* beacon.append({
        streamId: streamIds.bot(dev.id),
        type: "message.inbound",
        payload: { channel: "telegram", chatId: FORUM_CHAT, userId: "42", text: "oi", botId: dev.id },
        actor: "user:telegram:42",
        correlationId: "corr-inbound-1",
      })
      yield* out.send(dev.id, "pronto", { inReplyTo: inbound.id })
      expect(fake.sent).toHaveLength(1)

      const events = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.outbound"])))
      expect(events).toHaveLength(1)
      const [event] = events
      expect(event?.correlationId).toBe("corr-inbound-1")
      expect(event?.causationId).toBe(inbound.id)
      expect(event?.payload).toMatchObject({
        channel: "telegram",
        botId: dev.id,
        text: "pronto",
        inReplyTo: inbound.id,
        latencyMs: expect.any(Number),
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("turns a transport failure into a TelegramError whose message never shows the token", () =>
    Effect.gen(function* () {
      const failure = new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)
      const { dev, out } = yield* setup(failure)
      const error = yield* Effect.flip(out.send(dev.id, "oi"))
      expect(error).toBeInstanceOf(TelegramError)
      expect(error.op).toBe("sendMessage")
      expect(error.message).not.toContain("fake-token")
      expect(error.message).toContain("bot<redacted>")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("measures latency on the Effect clock, not on the wall clock", () =>
    Effect.gen(function* () {
      const { dev, out, beacon } = yield* setup()
      const inbound = yield* beacon.append({
        streamId: streamIds.bot(dev.id),
        type: "message.inbound",
        payload: { channel: "telegram", chatId: FORUM_CHAT, userId: "42", text: "oi", botId: dev.id },
        actor: "user:telegram:42",
        correlationId: "corr-clock",
      })
      const occurredAt = DateTime.toEpochMillis(inbound.occurredAt)
      const clock = yield* Clock.clockWith((current) => Effect.succeed(current))
      yield* out.send(dev.id, "pronto", { inReplyTo: inbound.id }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillis: Effect.succeed(occurredAt + 1500),
        }),
      )
      const events = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.outbound"])))
      expect(events[0]?.payload).toMatchObject({ latencyMs: 1500 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failed message.outbound append is logged after the send, not returned to the caller", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const dev = yield* registry.upsert(DEV_DEF, "test")
      const real = yield* Beacon
      const flaky: BeaconShape = {
        ...real,
        append: (e, opts) =>
          e.type === "message.outbound"
            ? Effect.fail(new Conflict({ streamId: e.streamId, expectedVersion: 0 }))
            : real.append(e, opts),
      }
      const fake = makeFakeTelegram()
      const sql = yield* SqlClient
      const out = makeTelegramOut({ api: fake.api, forumChatId: FORUM_CHAT, sql, beacon: flaky, registry })
      yield* out.send(dev.id, "pronto")
      expect(fake.sent).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an inReplyTo that does not resolve still sends, without latency", () =>
    Effect.gen(function* () {
      const { dev, fake, out } = yield* setup()
      const missing = Schema.decodeUnknownSync(EventId)("evt_00000000-0000-4000-8000-000000000999")
      yield* out.send(dev.id, "oi", { inReplyTo: missing })
      expect(fake.sent).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("typing never fails the caller when the chat action is refused", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const dev = yield* registry.upsert(DEV_DEF, "test")
      const fake = makeFakeTelegram({ failChatAction: true })
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const out = makeTelegramOut({ api: fake.api, forumChatId: FORUM_CHAT, sql, beacon, registry })
      yield* out.typing(dev.id)
      expect(fake.chatActions).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})
