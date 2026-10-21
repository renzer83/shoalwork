import type { BotRegistryShape } from "@shoalwork/bots"
import type { Bot, BotId, Event } from "@shoalwork/contracts"
import { Effect } from "effect"
import {
  type ControlRequest,
  controlUsageText,
  type Invocation,
  parseControl,
  parseInvocation,
  staticReply,
  statusText,
} from "./commands.js"
import type { ControlShape } from "./control.js"
import { statusRows } from "./conversation-context.js"
import type { Lang } from "./narrator.js"
import { actorFor, type ReplyChannel } from "./reply-port.js"
import type { TaskStoreShape } from "./tasks.js"

const isControlCommand = (command: string) =>
  command === "stop" || command === "pause" || command === "resume"

const isMemoryCommand = (command: string) =>
  command === "remember" || command === "forget" || command === "memory"

export interface CommandDeps {
  readonly bots: BotRegistryShape
  readonly tasks: TaskStoreShape
  readonly control: ControlShape
  readonly say: (botId: BotId, text: string, inReplyTo?: Event["id"]) => Effect.Effect<void>
  readonly channel: ReplyChannel
  readonly controlReplies: (request: ControlRequest, by: string, language: Lang) => Effect.Effect<string>
  // Absent when there is no Reef: /remember and /forget are then unknown commands.
  readonly memoryReplies:
    | ((
        event: Event,
        bot: Bot,
        invocation: Invocation,
        text: string,
        userId: string,
        language: Lang,
      ) => Effect.Effect<void, unknown>)
    | undefined
}

// The slash commands of the conversation (intent "system"): /status, the pause family, the memory commands, /help.
export const makeCommandAnswers =
  ({ bots, tasks, control, say, controlReplies, memoryReplies, channel }: CommandDeps) =>
  (event: Event, bot: Bot, text: string, userId: string, language: Lang) =>
    Effect.gen(function* () {
      const invocation = parseInvocation(text)
      if (invocation?.command === "status") {
        const rows = yield* statusRows(bots, tasks)
        const { paused } = yield* control.status()
        return yield* say(bot.id, statusText(rows, language, paused), event.id)
      }
      if (invocation !== undefined && memoryReplies !== undefined && isMemoryCommand(invocation.command)) {
        return yield* memoryReplies(event, bot, invocation, text, userId, language)
      }
      const request = invocation === undefined ? undefined : parseControl(invocation)
      if (invocation !== undefined && request === undefined && isControlCommand(invocation.command)) {
        return yield* say(bot.id, controlUsageText(language), event.id)
      }
      if (request === undefined) {
        return yield* say(bot.id, staticReply(invocation?.command, language), event.id)
      }
      const reply = yield* controlReplies(request, actorFor(channel, userId), language)
      yield* say(bot.id, reply, event.id)
    })
