import { Schema } from "effect"
import { Bot } from "../bot.js"
import { BotState } from "../enums.js"
import { BotId, TaskId } from "../ids.js"

export const BotCreatedPayload = Schema.Struct({
  bot: Bot,
  by: Schema.String,
})

export const BotStateChangedPayload = Schema.Struct({
  botId: BotId,
  from: BotState,
  to: BotState,
  taskId: Schema.optional(TaskId),
})

// A Bot proposed by conversation and what became of it. Ids and names only: never the model's text.
export const BotProposedPayload = Schema.Struct({
  proposalId: Schema.String,
  botName: Schema.String,
  requestedBy: Schema.String,
})

export const BotProposalResolvedPayload = Schema.Struct({
  proposalId: Schema.String,
  botName: Schema.String,
  status: Schema.Literals(["confirmed", "rejected", "expired", "failed"]),
})
