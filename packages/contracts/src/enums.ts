import { Schema } from "effect"

export const Risk = Schema.Literals(["read", "write_local", "external", "irreversible"])
export type Risk = typeof Risk.Type

export const ModelTier = Schema.Literals(["chat", "decision", "light", "heavy"])
export type ModelTier = typeof ModelTier.Type

export const BotKind = Schema.Literals(["fixed", "auxiliary"])
export type BotKind = typeof BotKind.Type

export const BotState = Schema.Literals([
  "idle",
  "thinking",
  "working",
  "waiting_approval",
  "blocked",
  "done",
  "paused",
  "archived",
])
export type BotState = typeof BotState.Type

export const TaskState = Schema.Literals([
  "received",
  "planning",
  "ready",
  "running",
  "waiting_approval",
  "verifying",
  "done",
  "failed",
  "cancelled",
])
export type TaskState = typeof TaskState.Type

export const TaskKind = Schema.Literals(["chat", "system", "code", "research", "app_op", "routine"])
export type TaskKind = typeof TaskKind.Type

export const TaskOrigin = Schema.Literals(["telegram", "app", "api", "cli", "tide", "bot"])
export type TaskOrigin = typeof TaskOrigin.Type

export const VerdictKind = Schema.Literals(["ok", "failed", "needs_approval", "budget_exceeded", "blocked"])
export type VerdictKind = typeof VerdictKind.Type

export const TankMode = Schema.Literals(["local", "server"])
export type TankMode = typeof TankMode.Type

export const MemoryScope = Schema.Literals(["bot", "pod", "global"])
export type MemoryScope = typeof MemoryScope.Type
