import { fileURLToPath } from "node:url"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import {
  type Bot,
  type BotId,
  type Event,
  type EventId,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorTask,
  NewBot,
  SchemaViolation,
  streamIds,
} from "@shoalwork/contracts"
import { TelegramError, TelegramOut, type TelegramOutShape } from "@shoalwork/currents"
import { ChatSessionsLive, type Executor, type TierConfig } from "@shoalwork/executors"
import { loadReflexConfig, makeReflexLive, type ReflexConfig } from "@shoalwork/reflex"
import { Effect, Layer, Schema, type Stream } from "effect"
import { ConversationLive, type ConversationOptions } from "../src/conversation.js"
import { Lead } from "../src/lead.js"
import { eventsOf, fakeExecutor, leadLayer, makeFakeTank, OK_EVENTS, TEST_TIERS } from "./support.js"

const CHAT = Schema.decodeUnknownSync(ExecutorId)("claude-code@chat")

export const REFLEX_CONFIG: ReflexConfig = Effect.runSync(
  loadReflexConfig(fileURLToPath(new URL("../../../config/reflex.config.yaml", import.meta.url))),
)

export const newBot = (
  name: string,
  role: string,
  kind: "fixed" | "auxiliary" = "auxiliary",
  over: Readonly<Record<string, unknown>> = {},
) =>
  Schema.decodeUnknownSync(NewBot)({
    name,
    role,
    kind,
    instructions: `You are ${name}.`,
    executors: { preferred: "claude-code", allowed: ["claude-code"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 500000, seconds: 1800, usd: 5 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
    ...over,
  })

// The Lead's own Bot and one developer Bot, as bots/*.yaml would create them.
export const createBotsWith = (leadOver: Readonly<Record<string, unknown>> = {}) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const lead = yield* registry.upsert(newBot("lead", "coordinator", "fixed", leadOver), "test")
    const dev = yield* registry.upsert(newBot("worker-bot", "developer"), "test")
    return { lead, dev }
  })

export const createBots = createBotsWith()

export interface SentMessage {
  readonly botId: BotId
  readonly text: string
  readonly inReplyTo?: EventId
  // The inline keyboard the message carried, as callback data in order.
  readonly buttons?: ReadonlyArray<string>
}

export interface FakeTelegramOut {
  readonly shape: TelegramOutShape
  readonly sent: Array<SentMessage>
  readonly typing: Array<BotId>
  readonly topics: Array<string>
}

export const makeFakeTelegramOut = (
  opts: { readonly failSend?: boolean; readonly failTopicFor?: string } = {},
): FakeTelegramOut => {
  const sent: Array<SentMessage> = []
  const typing: Array<BotId> = []
  const topics: Array<string> = []
  const shape: TelegramOutShape = {
    send: (botId, text, flags) =>
      opts.failSend === true
        ? Effect.fail(new TelegramError({ op: "sendMessage", message: "down" }))
        : Effect.sync(() => {
            sent.push({
              botId,
              text,
              ...(flags?.inReplyTo === undefined ? {} : { inReplyTo: flags.inReplyTo }),
              ...(flags?.replyMarkup === undefined
                ? {}
                : {
                    buttons: (flags.replyMarkup.inline_keyboard.flat() as ReadonlyArray<object>).map(
                      (button) => ("callback_data" in button ? String(button.callback_data) : ""),
                    ),
                  }),
            })
          }),
    // A proposal goes out through sendRef: it is recorded like send, and its keyboard edits are not read.
    sendRef: (botId, text, flags) =>
      Effect.sync(() => {
        sent.push({
          botId,
          text,
          ...(flags?.inReplyTo === undefined ? {} : { inReplyTo: flags.inReplyTo }),
        })
        return { chatId: "-100", messageId: sent.length }
      }),
    editReplyMarkup: () => Effect.void,
    typing: (botId) =>
      Effect.sync(() => {
        typing.push(botId)
      }),
    ensureTopic: (bot: Bot) =>
      bot.name === opts.failTopicFor
        ? Effect.fail(new TelegramError({ op: "createForumTopic", message: "down" }))
        : Effect.sync(() => {
            topics.push(bot.name)
            return { chatId: "-100", threadId: topics.length }
          }),
    openPodTopic: () => Effect.succeed(1),
    postToPodTopic: () => Effect.void,
  }
  return { shape, sent, typing, topics }
}

export interface FakeChat {
  readonly executor: Executor
  // Every task the chat executor was asked to run, in order (chat turns and decision-tier questions).
  readonly runs: Array<ExecutorTask>
}

// The chat executor: `reply` decides the events per task; the default answers "ola" to chat and "{}" to the rest.
export const fakeChat = (
  reply: (task: ExecutorTask) => Stream.Stream<ExecutorEvent, never> = (task) =>
    eventsOf([{ kind: "done", result: task.tier === "decision" ? "{}" : "ola", artifacts: [] }])(),
): FakeChat => {
  const runs: Array<ExecutorTask> = []
  const base = fakeExecutor((task) => reply(task), runs)
  return { executor: { ...base, id: CHAT }, runs }
}

export interface ConversationHarness {
  readonly layer: ReturnType<typeof build>
  readonly telegram: FakeTelegramOut
  readonly chat: FakeChat
}

const build = (
  chat: FakeChat,
  telegram: FakeTelegramOut,
  tiers: TierConfig,
  config: ReflexConfig,
  options: ConversationOptions,
  leadEvents: ReadonlyArray<ExecutorEvent>,
  failIntake: boolean,
) => {
  const lead = leadLayer({
    executor: fakeExecutor(eventsOf(leadEvents)),
    extra: [chat.executor],
    tiers,
    tank: makeFakeTank(),
  })
  // The Lead whose intake refuses every task (a database or schema problem after the ack).
  const failing = Layer.effect(
    Lead,
    Effect.map(Lead, (real) => ({
      ...real,
      intake: () => Effect.fail(new SchemaViolation({ where: "TaskSpec", issue: "refused" })),
    })),
  )
  const withReflex = Layer.provideMerge(
    makeReflexLive(config),
    failIntake ? Layer.provideMerge(failing, lead) : lead,
  )
  const withSessions = Layer.provideMerge(ChatSessionsLive, withReflex)
  const withTelegram = Layer.provideMerge(Layer.succeed(TelegramOut, telegram.shape), withSessions)
  return Layer.provideMerge(ConversationLive(tiers, config, options), withTelegram)
}

export const harness = (
  opts: {
    readonly chat?: FakeChat
    readonly telegram?: FakeTelegramOut
    readonly config?: ReflexConfig
    readonly options?: ConversationOptions
    // What the Lead's task executor (not the chat one) streams.
    readonly leadEvents?: ReadonlyArray<ExecutorEvent>
    readonly failIntake?: boolean
  } = {},
): ConversationHarness => {
  const chat = opts.chat ?? fakeChat()
  const telegram = opts.telegram ?? makeFakeTelegramOut()
  return {
    layer: build(
      chat,
      telegram,
      TEST_TIERS,
      opts.config ?? REFLEX_CONFIG,
      opts.options ?? {},
      opts.leadEvents ?? OK_EVENTS,
      opts.failIntake ?? false,
    ),
    telegram,
    chat,
  }
}

// A message.inbound as the Telegram connector records it, in the topic of `bot`.
export const inbound = (
  bot: Bot,
  text: string,
  over: { readonly userId?: string; readonly botId?: string } = {},
) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* beacon.append({
      streamId: streamIds.bot(bot.id),
      type: "message.inbound",
      payload: {
        channel: "telegram",
        chatId: "-100",
        threadId: "1",
        userId: over.userId ?? "42",
        text,
        botId: over.botId ?? bot.id,
      },
      actor: "user:telegram:42",
      correlationId: crypto.randomUUID(),
    })
  })

// A message.inbound as POST /messages records it (T-113): channel "app", the operator as user.
export const inboundApp = (bot: Bot, text: string) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* beacon.append({
      streamId: streamIds.bot(bot.id),
      type: "message.inbound",
      payload: { channel: "app", userId: "user:app", text, botId: bot.id },
      actor: "user:app",
      correlationId: crypto.randomUUID(),
    })
  })

export const typesOf = (events: ReadonlyArray<Event>) => events.map((event) => event.type)

// Lets forked fibers run: the narrator and the inbound loop consume pub/sub streams on their own fibers.
export const settle = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { discard: true })
