import { type Bot, BotId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { InlineKeyboard } from "grammy"
import { type TelegramError, telegramError } from "./errors.js"

// The subset of the grammY Api this package calls. grammY's `bot.api` satisfies it; tests pass a fake.
export interface SendOptions {
  readonly parse_mode: "HTML"
  readonly message_thread_id: number
  readonly reply_markup?: InlineKeyboard
}

export interface TelegramApi {
  sendMessage(chatId: string, text: string, other: SendOptions): Promise<{ readonly message_id: number }>
  // An empty `other` removes the inline keyboard of the message.
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    other: { readonly reply_markup?: InlineKeyboard },
  ): Promise<unknown>
  sendChatAction(
    chatId: string,
    action: "typing",
    other: { readonly message_thread_id: number },
  ): Promise<unknown>
  createForumTopic(chatId: string, name: string): Promise<{ readonly message_thread_id: number }>
}

export interface TopicRef {
  readonly chatId: string
  readonly threadId: number
}

// A message already on the wire, addressed for later edits (e.g. removing its buttons).
export interface MessageRef {
  readonly chatId: string
  readonly messageId: number
}

const TopicRow = Schema.Struct({ chat_id: Schema.String, thread_id: Schema.Int })
const TopicRows = Schema.Array(TopicRow)
const BotIdRow = Schema.Struct({ bot_id: BotId })
const BotIdRows = Schema.Array(BotIdRow)

// Rows are written by this package only: a mismatch is a bug, so it dies instead of becoming a typed error.
const decodeTopicRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(TopicRows)(rows).pipe(Effect.orDie)
const decodeBotIdRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(BotIdRows)(rows).pipe(Effect.orDie)

const readRow = (sql: SqlClient, botId: BotId) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT chat_id, thread_id FROM telegram_topics WHERE bot_id = ${botId}`
    const [row] = yield* decodeTopicRows(rows)
    return row === undefined ? undefined : { chatId: row.chat_id, threadId: row.thread_id }
  })

// A stored topic counts only for the forum chat in use now; a row from another chat is recreated.
const cachedFor = (
  row: { readonly chatId: string; readonly threadId: number } | undefined,
  forumChatId: string,
): TopicRef | undefined => (row !== undefined && row.chatId === forumChatId ? row : undefined)

// Cache in telegram_topics first; on a miss, create the forum topic named after the Bot and store it.
// Two service instances on the same database can race past the first read: the re-read before the
// create narrows that window, and the insert is ON CONFLICT DO NOTHING, so the stored row is the one
// that wins and is returned. The loser's forum topic is left in Telegram and logged.
export const ensureTopic = (
  sql: SqlClient,
  api: TelegramApi,
  forumChatId: string,
  bot: Pick<Bot, "id" | "name">,
): Effect.Effect<TopicRef, TelegramError> =>
  Effect.gen(function* () {
    const first = cachedFor(
      yield* readRow(sql, bot.id).pipe(Effect.mapError(telegramError("topic.read"))),
      forumChatId,
    )
    if (first !== undefined) {
      return first
    }
    const beforeCreate = cachedFor(
      yield* readRow(sql, bot.id).pipe(Effect.mapError(telegramError("topic.read"))),
      forumChatId,
    )
    if (beforeCreate !== undefined) {
      return beforeCreate
    }
    const created = yield* Effect.tryPromise({
      try: () => api.createForumTopic(forumChatId, bot.name),
      catch: telegramError("createForumTopic"),
    })
    const winner = yield* Effect.gen(function* () {
      yield* sql`DELETE FROM telegram_topics WHERE bot_id = ${bot.id} AND chat_id <> ${forumChatId}`
      yield* sql`INSERT INTO telegram_topics (bot_id, chat_id, thread_id, created_at)
        VALUES (${bot.id}, ${forumChatId}, ${created.message_thread_id}, ${nowIso()})
        ON CONFLICT (bot_id) DO NOTHING`
      return yield* readRow(sql, bot.id)
    }).pipe(Effect.mapError(telegramError("topic.write")))
    if (winner === undefined) {
      return yield* Effect.die(new Error("telegram_topics row missing right after insert"))
    }
    if (winner.threadId !== created.message_thread_id) {
      yield* Effect.logWarning(
        `telegram topic for ${bot.name} was created by another instance; kept the stored one`,
      )
    }
    return winner
  })

// Inbound side: which Bot owns a forum topic. undefined for DMs and the General topic.
export const findBotByTopic = (
  sql: SqlClient,
  chatId: string,
  threadId: number,
): Effect.Effect<BotId | undefined, TelegramError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT bot_id FROM telegram_topics
      WHERE chat_id = ${chatId} AND thread_id = ${threadId}`
    const [row] = yield* decodeBotIdRows(rows)
    return row?.bot_id
  }).pipe(Effect.mapError(telegramError("topic.lookup")))
