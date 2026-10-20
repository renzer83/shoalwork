import { randomUUID } from "node:crypto"
import { autoRetry } from "@grammyjs/auto-retry"
import { sequentialize } from "@grammyjs/runner"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape } from "@shoalwork/bots"
import { type BotId, streamIds } from "@shoalwork/contracts"
import { Cause, Effect, type Context as EffectContext } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Bot as GrammyBot, type Context as GrammyContext } from "grammy"
import type { UserFromGetMe } from "grammy/types"
import { describeError, tagOf } from "./errors.js"
import { findBotByTopic } from "./topics.js"

// Name of the Bot that answers everything without a topic (DMs, General). Fixed by the bots/ definitions.
const LEAD_NAME = "lead"

export interface BotOptions {
  readonly botInfo?: UserFromGetMe
  // Bot API root; default is api.telegram.org. Tests point it at a local fake server.
  readonly apiRoot?: string
}

// Transport retries (429, 5xx) by auto-retry; polling is driven by @grammyjs/runner, not by bot.start().
export const createTelegramBot = (token: string, options: BotOptions = {}): GrammyBot => {
  const config = {
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
    ...(options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } }),
  }
  const bot = new GrammyBot(token, config)
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }))
  return bot
}

export interface InboundOptions {
  readonly allowedUserIds: ReadonlySet<number>
  // The only group accepted besides DMs. Messages from any other chat are ignored.
  readonly forumChatId: string
  // Services the inbound handler reads (Beacon, BotRegistry, SqlClient), captured by the caller's Layer.
  readonly context: EffectContext.Context<Beacon | BotRegistry | SqlClient>
}

export interface InboundMessage {
  readonly chatId: string
  readonly threadId: number | undefined
  readonly userId: string
  readonly text: string
}

const leadId = (registry: BotRegistryShape) =>
  registry.getByName(LEAD_NAME).pipe(
    Effect.map((bot): BotId | undefined => bot.id),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  )

// Every failure outside a typed path becomes an error.raised event: tag and redacted text only,
// never the user's message and never a raw error object.
export const reportFailure = (where: string) => (error: unknown) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon
      .append({
        streamId: streamIds.system,
        type: "error.raised",
        payload: { where, tag: tagOf(error), message: describeError(error) },
        actor: "system:telegram",
        correlationId: randomUUID(),
      })
      .pipe(
        Effect.catch((appendError) =>
          Effect.logError("telegram failure not recorded", describeError(appendError)),
        ),
      )
  })

// A middleware error: redacted log line (nested causes included) plus error.raised. Never a raw console dump.
export const reportBotError = (error: unknown) =>
  Effect.gen(function* () {
    yield* Effect.logError("telegram handler failed", describeError(error))
    yield* reportFailure("telegram.handler")(error)
  })

// Topic messages go to the Bot that owns the topic; anything else goes to the lead.
export const recordInbound = (message: InboundMessage) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const sql = yield* SqlClient
    const registry = yield* BotRegistry
    const topicBot =
      message.threadId === undefined
        ? undefined
        : yield* findBotByTopic(sql, message.chatId, message.threadId)
    const botId = topicBot ?? (yield* leadId(registry))
    yield* beacon.append({
      streamId: botId === undefined ? streamIds.system : streamIds.bot(botId),
      type: "message.inbound",
      payload: {
        channel: "telegram",
        chatId: message.chatId,
        userId: message.userId,
        text: message.text,
        ...(message.threadId === undefined ? {} : { threadId: String(message.threadId) }),
        ...(botId === undefined ? {} : { botId }),
      },
      actor: `user:telegram:${message.userId}`,
      correlationId: randomUUID(),
    })
  }).pipe(
    Effect.catchCause((cause) => reportFailure("telegram.inbound")(Cause.squash(cause))),
    Effect.asVoid,
  )

// The two gates every update passes: an allowlisted sender, and a DM or the forum chat. Shared with callbacks.ts.
export const senderAllowed = (ctx: GrammyContext, options: Pick<InboundOptions, "allowedUserIds">): boolean =>
  ctx.from !== undefined && options.allowedUserIds.has(ctx.from.id)

export const chatAllowed = (ctx: GrammyContext, options: Pick<InboundOptions, "forumChatId">): boolean =>
  ctx.chat?.type === "private" || String(ctx.chat?.id) === options.forumChatId

// Middlewares in order: allowlist (silent drop) -> chat gate (DM or forum chat) -> sequentialize per chat -> text handler.
export const installInbound = (bot: GrammyBot, options: InboundOptions): void => {
  bot.use(async (ctx, next) => {
    if (senderAllowed(ctx, options)) {
      await next()
    }
  })
  bot.use(async (ctx, next) => {
    if (chatAllowed(ctx, options)) {
      await next()
    }
  })
  bot.use(sequentialize((ctx: GrammyContext) => ctx.chat?.id.toString()))
  bot.on("message:text", (ctx) => {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (userId === undefined || chatId === undefined) {
      return Promise.resolve()
    }
    return Effect.runPromiseWith(options.context)(
      recordInbound({
        chatId: String(chatId),
        threadId: ctx.message.message_thread_id,
        userId: String(userId),
        text: ctx.message.text,
      }),
    )
  })
  // Errors thrown by any middleware land here (grammY routes them here on the runner path).
  bot.catch((botError) => Effect.runPromiseWith(options.context)(reportBotError(botError.error)))
}
