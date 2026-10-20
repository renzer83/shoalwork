import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { Bot, BotId, Event, TaskId } from "@shoalwork/contracts"
import { TelegramOut } from "@shoalwork/currents"
import { ChatSessions, ExecutorRegistry, makeWarmChatPool, type TierConfig } from "@shoalwork/executors"
import { Reef } from "@shoalwork/reef"
import { belowThreshold, Reflex, type ReflexConfig } from "@shoalwork/reflex"
import { Tank } from "@shoalwork/tank"
import { Cause, Context, Effect, Layer, Option, type Scope, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { BotFactoryDeps } from "./bot-factory.js"

export type { BotFactoryOptions, ConversationOptions } from "./conversation-options.js"

import { BOT_BUDGET_WINDOW_MS, botOverBudget } from "./budget.js"
import { ChatFailure, makeChat } from "./chat.js"
import { Control } from "./control.js"
import { makeCommandAnswers } from "./conversation-commands.js"
import {
  decodeInbound,
  factsFor,
  isTaskIntent,
  ownerFor,
  reportFailure,
  summarize,
} from "./conversation-context.js"
import { makeControlReplies } from "./conversation-control.js"
import { makeFactoryStep } from "./conversation-factory.js"
import { makeMemoryReplies } from "./conversation-memory.js"
import type { ConversationOptions } from "./conversation-options.js"
import { type Acked, makeChatAnswer, makeHandOff } from "./conversation-replies.js"
import { makeResumeAnswers } from "./conversation-resume.js"
import { escalate } from "./escalation.js"
import { Lead } from "./lead.js"
import { startNarrator } from "./narrate.js"
import { ack, ackUnnamedPhrase, failedPhrase, type Lang, langOf } from "./narrator.js"
import { parseResumeRequest } from "./resume-request.js"
import { TaskStore } from "./tasks.js"

export interface ConversationShape {
  // Handles one message.inbound. Never fails: every problem becomes an error.raised event.
  readonly onInbound: (event: Event) => Effect.Effect<void>
  // Creates the Bots' topics, then answers every message.inbound and narrates the tasks' progress, until the scope ends.
  readonly start: Effect.Effect<void, never, Scope.Scope>
}

export class Conversation extends Context.Service<Conversation, ConversationShape>()(
  "@shoalwork/Conversation",
) {}

const _isControlCommand = (command: string) =>
  command === "stop" || command === "pause" || command === "resume"

const _isMemoryCommand = (command: string) =>
  command === "remember" || command === "forget" || command === "memory"

const _INSTRUCTIONS_MAX = 2000
const _TITLE_MAX = 80
// Bots whose topic is created at the same time at boot.
const TOPIC_CONCURRENCY = 4

export const ConversationLive = (
  tiers: TierConfig,
  reflexConfig: ReflexConfig,
  options: ConversationOptions = {},
) =>
  Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const executors = yield* ExecutorRegistry
      const tank = yield* Tank
      const reflex = yield* Reflex
      const telegram = yield* TelegramOut
      const lead = yield* Lead
      const control = yield* Control
      const tasks = yield* TaskStore
      const sessions = yield* ChatSessions
      const factorySql = yield* SqlClient
      const warm =
        options.warm === undefined
          ? undefined
          : yield* makeWarmChatPool(options.warm).pipe(Effect.provideService(Tank, tank))
      const chat = makeChat({
        tank,
        bots,
        executors,
        sessions,
        tiers,
        ...(warm === undefined ? {} : { warm }),
        ...(options.chatTimeoutMs === undefined ? {} : { timeoutMs: options.chatTimeoutMs }),
      })
      // The model that drafts a Bot answers on the heavy tier, through the Lead's own Bot.
      const botFactory: BotFactoryDeps | undefined =
        options.botFactory === undefined
          ? undefined
          : {
              ...options.botFactory,
              sql: factorySql,
              bots,
              telegram,
              ask: (prompt) =>
                bots.getByName(reflexConfig.owner.leadName).pipe(
                  Effect.mapError(
                    () => new ChatFailure({ reason: "error", message: "the Lead Bot is not registered" }),
                  ),
                  Effect.flatMap((lead) => chat.heavy(lead.id, prompt)),
                ),
            }
      const factoryStep = botFactory === undefined ? undefined : makeFactoryStep(beacon, botFactory)
      // The Reef answers /remember and /forget; without one (tests, a core booted without it) they are unknown.
      const reef = options.memory ?? Option.getOrUndefined(yield* Effect.serviceOption(Reef))
      const memoryReplies = reef === undefined ? undefined : makeMemoryReplies({ memory: reef, telegram })
      // Typing indicators outlive the message that asked for them.
      const layerScope = yield* Effect.scope
      const languages = new Map<TaskId, Lang>()
      const context = { beacon, bots, executors }

      const say = (botId: BotId, text: string, inReplyTo?: Event["id"]) =>
        telegram
          .send(botId, text, inReplyTo === undefined ? {} : { inReplyTo })
          .pipe(Effect.catch((error) => Effect.logWarning("reply not sent", error.op)))

      const answerCommand = makeCommandAnswers({
        bots,
        tasks,
        control,
        say,
        memoryReplies,
        controlReplies: makeControlReplies({ bots, control }),
      })

      const answerChat = makeChatAnswer({ beacon, chat, say })
      const handOff = makeHandOff({ bots, lead, say, languages })
      const answerResume = makeResumeAnswers({ tasks, lead, say, languages })

      const route = (event: Event) =>
        Effect.gen(function* () {
          const payload = decodeInbound(event.payload)
          if (
            Option.isNone(payload) ||
            payload.value.channel !== "telegram" ||
            payload.value.text.trim() === ""
          ) {
            return
          }
          const { text, userId, chatId, threadId } = payload.value
          const topicBotId = payload.value.botId ?? (yield* bots.getByName(reflexConfig.owner.leadName)).id
          const topicBot = yield* bots.get(topicBotId)
          // Creating a Bot by conversation is decided before the Reflex: a confirmation is not a chat message.
          if (factoryStep !== undefined && (yield* factoryStep(event, topicBot, text, userId))) {
            return
          }
          // A message in another Bot's topic is addressed to that Bot; in the Lead's topic the rules pick the owner.
          const hint = topicBot.name === reflexConfig.owner.leadName ? undefined : topicBot.id
          const facts = yield* factsFor(context, event, text, userId, hint)
          const decided = yield* reflex.standard(facts)
          const language = langOf(decided.language)
          // "continua a task <id|título>": decided by the text, the Reflex only supplied the language.
          const resumeRequest = parseResumeRequest(text)
          if (resumeRequest !== undefined) {
            return yield* answerResume(event, topicBot, resumeRequest, language)
          }
          if (decided.intent !== "system") {
            yield* Effect.forkIn(telegram.typing(topicBot.id), layerScope)
          }
          // The rules saw a task: acknowledge now, before any (slow) escalation. The rule's owner is named only
          // when the rules are sure of it.
          let acked: Acked = { sent: false }
          if (isTaskIntent(decided.intent)) {
            const rule = ownerFor(decided, facts)
            const ownerConfidence = decided.answers.find((answer) => answer.id === "owner")?.confidence ?? 0
            const sure = rule !== undefined && !belowThreshold(reflexConfig, "owner", ownerConfidence)
            // An owner already over its budget gets no "passei para" ack: intake refuses the task (conversation-replies.ts).
            const windowMs = options.botBudgetWindowMs ?? BOT_BUDGET_WINDOW_MS
            const refusedOwner = sure
              ? yield* botOverBudget(beacon, yield* bots.get(rule.id), windowMs)
              : false
            if (!refusedOwner) {
              yield* say(topicBot.id, sure ? ack(language, rule.name) : ackUnnamedPhrase(language), event.id)
              acked = sure ? { sent: true, owner: rule.id } : { sent: true }
            }
          }
          const decision = yield* escalate(
            {
              beacon,
              config: reflexConfig,
              ask: (prompt) => chat.once(topicBot.id, "decision", prompt),
              ...(options.minEscalationChars === undefined ? {} : { minChars: options.minEscalationChars }),
            },
            facts,
            decided,
            event.correlationId,
          )
          if (decision.intent === "chat") {
            return yield* answerChat(
              event,
              topicBot,
              text,
              `tg:${chatId ?? "-"}:${threadId ?? "0"}`,
              language,
            )
          }
          if (decision.intent === "system") {
            return yield* answerCommand(event, topicBot, text, userId, language)
          }
          yield* handOff(event, topicBot, text, decision, facts, language, acked).pipe(
            Effect.catch((error) => say(topicBot.id, failedPhrase(error._tag, language), event.id)),
          )
        })

      const report = (cause: Cause.Cause<unknown>) => reportFailure(beacon, cause)

      const onInbound: ConversationShape["onInbound"] = (event) =>
        route(event).pipe(
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : report(cause))),
        )

      // Subscribes first and starts answering at once; the topics are created meanwhile (a topic is also created on
      // the first send to a Bot, so a slow or failing ensureTopic delays nothing).
      const start: ConversationShape["start"] = Effect.gen(function* () {
        const inbound = yield* beacon.subscribe(["message.inbound"])
        yield* startNarrator({
          beacon,
          tasks,
          telegram,
          languageOf: (taskId) => languages.get(taskId) ?? "pt",
          forget: (taskId) => {
            languages.delete(taskId)
          },
          summarize: (summary, language) => summarize(chat, bots, summary, language),
        })
        yield* inbound.pipe(
          Stream.runForEach((event) => Effect.forkScoped(onInbound(event))),
          Effect.forkScoped,
        )
        const known = yield* bots.list().pipe(Effect.orElseSucceed((): ReadonlyArray<Bot> => []))
        yield* Effect.forEach(
          known,
          (bot) =>
            telegram
              .ensureTopic(bot)
              .pipe(Effect.catch((error) => Effect.logWarning("topic not ready", error.op))),
          { concurrency: TOPIC_CONCURRENCY, discard: true },
        )
      })

      return { onInbound, start }
    }),
  )
