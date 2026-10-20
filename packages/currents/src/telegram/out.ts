import { randomUUID } from "node:crypto"
import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type Bot, type BotId, type EventId, type NewEvent, streamIds } from "@shoalwork/contracts"
import { Clock, Context, Effect, Schema, Semaphore } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { InlineKeyboard } from "grammy"
import { describeError, type TelegramError, telegramError } from "./errors.js"
import { chunkText, escapeHtml } from "./format.js"
import { ensureTopic, type SendOptions, type TelegramApi, type TopicRef } from "./topics.js"

export interface SendFlags {
  readonly replyMarkup?: InlineKeyboard
  readonly inReplyTo?: EventId
}

export interface TelegramOutShape {
  readonly send: (botId: BotId, text: string, opts?: SendFlags) => Effect.Effect<void, TelegramError>
  readonly typing: (botId: BotId) => Effect.Effect<void>
  readonly ensureTopic: (bot: Bot) => Effect.Effect<TopicRef, TelegramError>
}

export class TelegramOut extends Context.Service<TelegramOut, TelegramOutShape>()("@shoalwork/TelegramOut") {}

export interface TelegramOutDeps {
  readonly api: TelegramApi
  readonly forumChatId: string
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly registry: BotRegistryShape
}

const InboundRow = Schema.Struct({ occurred_at: Schema.String, correlation_id: Schema.String })
const InboundRows = Schema.Array(InboundRow)

interface InboundRef {
  readonly occurredAt: string
  readonly correlationId: string
}

// The inbound event this reply answers: its time (for latency) and its correlation id.
const inboundOf = (sql: SqlClient, id: EventId): Effect.Effect<InboundRef | undefined, TelegramError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT occurred_at, correlation_id FROM events WHERE id = ${id}`
    const [row] = yield* Schema.decodeUnknownEffect(InboundRows)(rows).pipe(Effect.orDie)
    return row === undefined ? undefined : { occurredAt: row.occurred_at, correlationId: row.correlation_id }
  }).pipe(Effect.mapError(telegramError("inbound.lookup")))

// Latency on the Effect clock (TestClock-friendly), not on Date.now().
const latencyFrom = (occurredAt: string): Effect.Effect<number | undefined> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const latency = Math.round(now - Date.parse(occurredAt))
    return Number.isFinite(latency) ? Math.max(0, latency) : undefined
  })

export const makeTelegramOut = (deps: TelegramOutDeps): TelegramOutShape => {
  // Serializes topic creation inside this instance; the database-level insert settles races across instances.
  const topicLock = Semaphore.makeUnsafe(1)

  const topicOf = (bot: Bot): Effect.Effect<TopicRef, TelegramError> =>
    ensureTopic(deps.sql, deps.api, deps.forumChatId, bot).pipe(topicLock.withPermits(1))

  // Runs after the message is on the wire. A failure here is logged, never returned: the caller
  // must not retry a send that already happened.
  const recordOutbound = (
    botId: BotId,
    topic: TopicRef,
    text: string,
    inReplyTo: EventId | undefined,
    inbound: InboundRef | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const latencyMs = inbound === undefined ? undefined : yield* latencyFrom(inbound.occurredAt)
      const event: NewEvent = {
        streamId: streamIds.bot(botId),
        type: "message.outbound",
        payload: {
          channel: "telegram",
          chatId: topic.chatId,
          threadId: String(topic.threadId),
          botId,
          text,
          ...(latencyMs === undefined ? {} : { latencyMs }),
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
        },
        actor: `bot:${botId}`,
        correlationId: inbound?.correlationId ?? randomUUID(),
        ...(inReplyTo === undefined ? {} : { causationId: inReplyTo }),
      }
      yield* deps.beacon.append(event).pipe(Effect.catchTag("SchemaViolation", (error) => Effect.die(error)))
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("telegram message sent but message.outbound not recorded", describeError(error)),
      ),
    )

  const send = (botId: BotId, text: string, opts?: SendFlags): Effect.Effect<void, TelegramError> =>
    Effect.gen(function* () {
      const bot = yield* deps.registry.get(botId).pipe(Effect.mapError(telegramError("bot.get")))
      const topic = yield* topicOf(bot)
      const chunks = chunkText(text)
      if (chunks.length === 0) {
        return
      }
      // Resolved before the first chunk goes out: a failure here sends nothing, so a retry is safe.
      const inReplyTo = opts?.inReplyTo
      const inbound = inReplyTo === undefined ? undefined : yield* inboundOf(deps.sql, inReplyTo)
      const last = chunks.length - 1
      for (const [index, chunk] of chunks.entries()) {
        const other: SendOptions = {
          parse_mode: "HTML",
          message_thread_id: topic.threadId,
          ...(index === last && opts?.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup } : {}),
        }
        yield* Effect.tryPromise({
          try: () => deps.api.sendMessage(topic.chatId, escapeHtml(chunk), other),
          catch: telegramError("sendMessage"),
        })
      }
      yield* recordOutbound(botId, topic, text, inReplyTo, inbound)
    })

  // Best effort: a missing "typing" indicator never fails the caller.
  const typing = (botId: BotId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const bot = yield* deps.registry.get(botId).pipe(Effect.mapError(telegramError("bot.get")))
      const topic = yield* topicOf(bot)
      yield* Effect.tryPromise({
        try: () => deps.api.sendChatAction(topic.chatId, "typing", { message_thread_id: topic.threadId }),
        catch: telegramError("sendChatAction"),
      })
    }).pipe(Effect.catch((error) => Effect.logWarning("telegram typing skipped", describeError(error))))

  return {
    send,
    typing,
    ensureTopic: topicOf,
  }
}
