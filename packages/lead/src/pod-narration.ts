import type { BotRegistryShape } from "@shoalwork/bots"
import { type AgentMsg, type BotId, type Event, EventPayloads } from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import {
  cancelledPhrase,
  donePhrase,
  failedPhrase,
  podLinePhrase,
  safeLine,
  startedPhrase,
} from "./narrator.js"
import type { TaskRecord } from "./tasks.js"
import { clip } from "./verdict.js"

// One message may carry this much of a note from Renan or a Bot: the redacted line, cut.
export const NOTE_MAX = 1000
const HANDOFF_TITLE_MAX = 80

// The Bot's name for a line; a Bot the registry no longer knows speaks as "bot".
export const nameOf = (bots: BotRegistryShape, botId: BotId): Effect.Effect<string> =>
  bots.get(botId).pipe(
    Effect.map((bot) => bot.name),
    Effect.catch(() => Effect.succeed("bot")),
  )

const agentLine = (bots: BotRegistryShape, message: AgentMsg): Effect.Effect<string> => {
  switch (message.kind) {
    case "status":
      return nameOf(bots, message.bot).pipe(
        Effect.map((name) => podLinePhrase(name, safeLine(message.note ?? message.state, NOTE_MAX))),
      )
    case "handoff":
      return Effect.all([nameOf(bots, message.from), nameOf(bots, message.to)]).pipe(
        Effect.map(([from, to]) =>
          podLinePhrase(from, `passou para ${to}: ${clip(message.task.title, HANDOFF_TITLE_MAX)}`),
        ),
      )
    case "result":
      return nameOf(bots, message.from).pipe(
        Effect.map((name) => podLinePhrase(name, donePhrase(message.verdict.summary))),
      )
  }
}

// The line for one event of a step, or nothing when the event is not narrated.
export const lineOf = (
  bots: BotRegistryShape,
  event: Event,
  record: TaskRecord,
): Effect.Effect<Option.Option<string>> => {
  if (event.type === "agent.msg") {
    return Option.match(Schema.decodeUnknownOption(EventPayloads["agent.msg"])(event.payload), {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (message) => agentLine(bots, message).pipe(Effect.map(Option.some)),
    })
  }
  if (event.type !== "task.state_changed") {
    return Effect.succeed(Option.none<string>())
  }
  return Option.match(Schema.decodeUnknownOption(EventPayloads["task.state_changed"])(event.payload), {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (change) => {
      const summary = record.verdict?.summary ?? change.to
      const text =
        change.to === "running"
          ? startedPhrase()
          : change.to === "done"
            ? donePhrase(summary)
            : change.to === "failed"
              ? failedPhrase(summary)
              : change.to === "cancelled"
                ? cancelledPhrase()
                : undefined
      return nameOf(bots, record.spec.botId).pipe(
        Effect.map((name) =>
          text === undefined ? Option.none<string>() : Option.some(podLinePhrase(name, text)),
        ),
      )
    },
  })
}
