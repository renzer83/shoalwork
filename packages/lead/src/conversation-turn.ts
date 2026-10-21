import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import type { BotId, Event, TaskId } from "@shoalwork/contracts"
import type { TelegramOutShape } from "@shoalwork/currents"
import { DateTime, Effect } from "effect"
import type { Chat } from "./chat.js"
import type { MemoryPort } from "./commands/memory.js"
import type { ControlShape } from "./control.js"
import { makeCommandAnswers } from "./conversation-commands.js"
import { makeControlReplies } from "./conversation-control.js"
import { makeMemoryReplies } from "./conversation-memory.js"
import { makeChatAnswer, makeHandOff } from "./conversation-replies.js"
import { makeResumeAnswers } from "./conversation-resume.js"
import type { LeadShape } from "./lead.js"
import type { Lang } from "./narrator.js"
import type { ReplyChannel, ReplyPort } from "./reply-port.js"
import type { TaskStoreShape } from "./tasks.js"

export interface TurnDeps {
  readonly beacon: BeaconShape
  readonly bots: BotRegistryShape
  readonly tasks: TaskStoreShape
  readonly control: ControlShape
  readonly lead: LeadShape
  readonly chat: Chat
  readonly telegram: TelegramOutShape
  readonly reply: ReplyPort
  readonly languages: Map<TaskId, Lang>
  readonly memory: MemoryPort | undefined
}

// The answers of one conversation turn, bound to the channel the message came on. The logic is the same for every
// channel; only where the words go (and the origin the task is stored with) changes.
export const makeTurn = (deps: TurnDeps) => {
  const { beacon, bots, tasks, control, lead, chat, telegram, reply, languages, memory } = deps
  const controlReplies = makeControlReplies({ bots, control })
  return (channel: ReplyChannel, event: Event) => {
    // A failed send is logged, never raised: the turn is over either way.
    const say = (botId: BotId, text: string, inReplyTo?: Event["id"]) =>
      reply
        .send(channel, botId, text, {
          ...(inReplyTo === undefined ? {} : { replyTo: inReplyTo }),
          correlationId: event.correlationId,
          receivedAtMs: DateTime.toEpochMillis(event.occurredAt),
        })
        .pipe(Effect.catch((error) => Effect.logWarning("reply not sent", error.op)))
    const memoryReplies =
      memory === undefined ? undefined : makeMemoryReplies({ memory, telegram, say, channel })
    return {
      say,
      answerCommand: makeCommandAnswers({
        bots,
        tasks,
        control,
        say,
        memoryReplies,
        controlReplies,
        channel,
      }),
      answerChat: makeChatAnswer({ beacon, chat, say }),
      handOff: makeHandOff({ bots, lead, say, languages, channel }),
      answerResume: makeResumeAnswers({ tasks, lead, say, languages, channel }),
    }
  }
}
