import { Schema } from "effect"
import { Budget } from "./budget.js"
import { BotState } from "./enums.js"
import { BotId, TaskId } from "./ids.js"
import { Artifact, TaskSpec } from "./task.js"
import { Verdict } from "./verdict.js"

export const HandoffMsg = Schema.Struct({
  kind: Schema.Literal("handoff"),
  from: BotId,
  to: BotId,
  task: TaskSpec,
  budget: Budget,
})
export type HandoffMsg = typeof HandoffMsg.Type

export const ResultMsg = Schema.Struct({
  kind: Schema.Literal("result"),
  from: BotId,
  taskId: TaskId,
  verdict: Verdict,
  artifacts: Schema.Array(Artifact),
})
export type ResultMsg = typeof ResultMsg.Type

export const StatusMsg = Schema.Struct({
  kind: Schema.Literal("status"),
  bot: BotId,
  state: BotState,
  note: Schema.optional(Schema.String),
})
export type StatusMsg = typeof StatusMsg.Type

export const AgentMsg = Schema.Union([HandoffMsg, ResultMsg, StatusMsg]).pipe(Schema.toTaggedUnion("kind"))
export type AgentMsg = typeof AgentMsg.Type
