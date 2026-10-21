import type { Bot, Event } from "@shoalwork/contracts"
import { memoryButtons, type TelegramOutShape } from "@shoalwork/currents"
import { Effect } from "effect"
import {
  forgetCommand,
  type MemoryPort,
  type MemoryReply,
  memoryCallback,
  parseMemoryCallback,
  rememberCommand,
} from "./commands/memory.js"
import { type Invocation, unknownCommandText } from "./commands.js"
import type { Lang } from "./narrator.js"
import type { ReplyChannel } from "./reply-port.js"

// The text after the command name: "/remember@my_bot Deploy usa Fly" -> "Deploy usa Fly".
export const argumentText = (text: string): string => text.trim().replace(/^\/\w+(@\S+)?\s*/, "")

const withCommands = (reply: MemoryReply): string =>
  reply.buttons.length === 0
    ? reply.text
    : [reply.text, ...reply.buttons.map((button) => `${button.label}: /memory ${button.data}`)].join("\n")

// /remember, /forget and the "/memory <callback data>" that a /forget button press becomes. The Bot is the one that
// owns the topic the command came from; a failure of the database goes to the caller (the conversation reports it).
export const makeMemoryReplies =
  (deps: {
    readonly memory: MemoryPort
    readonly telegram: TelegramOutShape
    readonly say: (botId: Bot["id"], text: string, inReplyTo?: Event["id"]) => Effect.Effect<void>
    readonly channel: ReplyChannel
  }) =>
  (event: Event, topicBot: Bot, invocation: Invocation, text: string, userId: string, language: Lang) => {
    const { memory, telegram, say, channel } = deps
    // Buttons are a Telegram feature: the app gets the same choices as commands to send back (/memory <data>, the
    // command a button press becomes on Telegram).
    const send = (reply: MemoryReply) =>
      channel !== "telegram"
        ? say(topicBot.id, withCommands(reply), event.id)
        : telegram
            .send(topicBot.id, reply.text, {
              inReplyTo: event.id,
              ...(reply.buttons.length === 0 ? {} : { replyMarkup: memoryButtons(reply.buttons) }),
            })
            .pipe(Effect.catch((error) => Effect.logWarning("reply not sent", error.op)))
    // The source is stored as "user:<id>"; the app's operator id already starts with "user:".
    const sender = userId.startsWith("user:") ? userId.slice("user:".length) : userId
    const input = { botId: topicBot.id, userId: sender, text: argumentText(text) }
    return Effect.gen(function* () {
      if (invocation.command === "remember") {
        return yield* send(yield* rememberCommand(memory, input))
      }
      if (invocation.command === "forget") {
        return yield* send(yield* forgetCommand(memory, input))
      }
      const callback = parseMemoryCallback(argumentText(text))
      if (callback === undefined) {
        return yield* send({ text: unknownCommandText(language), buttons: [] })
      }
      yield* send(yield* memoryCallback(memory, { botId: topicBot.id, callback }))
    })
  }
