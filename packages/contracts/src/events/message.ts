import { Schema } from "effect"
import { AgentMsg } from "../agent-msg.js"
import { BotId, EventId } from "../ids.js"

export const Channel = Schema.Literals(["telegram", "api", "cli"])

export const MessageInboundPayload = Schema.Struct({
  channel: Channel,
  chatId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  userId: Schema.String,
  text: Schema.String,
  botId: Schema.optional(BotId),
})

export const MessageOutboundPayload = Schema.Struct({
  channel: Channel,
  chatId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  botId: BotId,
  text: Schema.String,
  latencyMs: Schema.optional(Schema.Int),
  inReplyTo: Schema.optional(EventId),
})

// A message between Bots (handoff, result, status), written to the stream of the task it belongs to (T-046).
export const AgentMsgPayload = AgentMsg
