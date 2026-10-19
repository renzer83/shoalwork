import { Schema, Struct } from "effect"
import { Budget } from "./budget.js"
import { BotKind, MemoryScope, TankMode } from "./enums.js"
import { BotId, ConnectorId, ExecutorId, PolicyId } from "./ids.js"

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type Effort = typeof Effort.Type

export const TierSpec = Schema.Struct({
  executor: ExecutorId,
  model: Schema.String,
  effort: Schema.optional(Effort),
})
export type TierSpec = typeof TierSpec.Type

// Per-Bot override of the global tier map. Every tier is optional.
export const ModelTierMap = Schema.Struct({
  chat: Schema.optionalKey(TierSpec),
  decision: Schema.optionalKey(TierSpec),
  light: Schema.optionalKey(TierSpec),
  heavy: Schema.optionalKey(TierSpec),
})
export type ModelTierMap = typeof ModelTierMap.Type

// Bot name becomes a directory, a git branch and a topic name: keep it filesystem-safe.
export const BotName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,30}$/)))

export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  role: Schema.String,
  instructions: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  kind: BotKind,
  executors: Schema.Struct({
    preferred: ExecutorId,
    allowed: Schema.Array(ExecutorId),
  }),
  modelTiers: ModelTierMap,
  connectors: Schema.Array(ConnectorId),
  budget: Budget,
  policy: PolicyId,
  tank: Schema.Struct({ mode: TankMode, host: Schema.String }),
  memory: Schema.Struct({ scope: MemoryScope }),
  telegram: Schema.optional(Schema.Struct({ threadId: Schema.Int })),
})
export type Bot = typeof Bot.Type

// Input shape for creating a Bot: the id is assigned by the core.
export const NewBot = Bot.mapFields(Struct.omit(["id"]))
export type NewBot = typeof NewBot.Type
