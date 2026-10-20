import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { BotId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { makeTelegramOut } from "../../src/telegram/out.js"
import { DEV_DEF, FORUM_CHAT, makeFakeTelegram, TestLayer } from "../support.js"

const topicRows = (botId: BotId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return yield* sql<{ readonly chat_id: string; readonly thread_id: number }>`SELECT chat_id, thread_id
      FROM telegram_topics WHERE bot_id = ${botId}`
  })

describe("ensureTopic", () => {
  it.effect("creates the Bot's topic once and reads the cache on the second call, even after a restart", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const dev = yield* registry.upsert(DEV_DEF, "test")
      const fake = makeFakeTelegram()
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const out = makeTelegramOut({ api: fake.api, forumChatId: FORUM_CHAT, sql, beacon, registry })

      const first = yield* out.ensureTopic(dev)
      const second = yield* out.ensureTopic(dev)
      expect(second).toEqual(first)
      expect(first.chatId).toBe(FORUM_CHAT)
      expect(fake.topicsCreated).toEqual([{ chatId: FORUM_CHAT, name: "dev" }])

      // A new service instance (process restart) still finds the topic in telegram_topics.
      const restarted = makeTelegramOut({ api: fake.api, forumChatId: FORUM_CHAT, sql, beacon, registry })
      expect(yield* restarted.ensureTopic(dev)).toEqual(first)
      expect(fake.topicsCreated).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("two concurrent calls on the same Bot create one forum topic and return the same thread", () =>
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
      const [a, b] = yield* Effect.all([out.ensureTopic(dev), out.ensureTopic(dev)], { concurrency: 2 })
      expect(a).toEqual(b)
      expect(fake.topicsCreated).toHaveLength(1)
      expect(yield* topicRows(dev.id)).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("two service instances on the same database end with one row and the stored thread", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const dev = yield* registry.upsert(DEV_DEF, "test")
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const fakeA = makeFakeTelegram()
      const fakeB = makeFakeTelegram()
      const outA = makeTelegramOut({ api: fakeA.api, forumChatId: FORUM_CHAT, sql, beacon, registry })
      const outB = makeTelegramOut({ api: fakeB.api, forumChatId: FORUM_CHAT, sql, beacon, registry })
      const [a, b] = yield* Effect.all([outA.ensureTopic(dev), outB.ensureTopic(dev)], { concurrency: 2 })
      expect(a).toEqual(b)
      const rows = yield* topicRows(dev.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.thread_id).toBe(a.threadId)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a row stored for another forum chat is replaced, not reused", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const dev = yield* registry.upsert(DEV_DEF, "test")
      const sql = yield* SqlClient
      yield* sql`INSERT INTO telegram_topics (bot_id, chat_id, thread_id, created_at)
        VALUES (${dev.id}, '-100999', 7, '2026-01-01T00:00:00.000Z')`
      const fake = makeFakeTelegram()
      const out = makeTelegramOut({
        api: fake.api,
        forumChatId: FORUM_CHAT,
        sql,
        beacon: yield* Beacon,
        registry,
      })
      const topic = yield* out.ensureTopic(dev)
      expect(topic.chatId).toBe(FORUM_CHAT)
      expect(fake.topicsCreated).toHaveLength(1)
      const rows = yield* topicRows(dev.id)
      expect(rows).toEqual([{ chat_id: FORUM_CHAT, thread_id: topic.threadId }])
    }).pipe(Effect.provide(TestLayer)),
  )
})
