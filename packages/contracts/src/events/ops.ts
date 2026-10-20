import { Schema } from "effect"
import { Budget } from "../budget.js"
import { BotId, TaskId } from "../ids.js"

export const WatchdogRecoveredPayload = Schema.Struct({
  what: Schema.Literals([
    "stale_task",
    "stale_job",
    "long_process",
    "expired_approval",
    "state_mismatch",
    "orphan_worktree",
  ]),
  ref: Schema.String,
  action: Schema.String,
})

export const BudgetExceededPayload = Schema.Struct({
  scope: Schema.Literals(["task", "bot", "pod"]),
  refId: Schema.String,
  limit: Budget,
  used: Budget,
})

export const ErrorRaisedPayload = Schema.Struct({
  where: Schema.String,
  tag: Schema.String,
  message: Schema.String,
  taskId: Schema.optional(TaskId),
  botId: Schema.optional(BotId),
})

// A pause, resume or stop asked by a person (or the watchdog). `scope` is "global", "bot:<id>" or "task:<id>".
export const ControlChangedPayload = Schema.Struct({
  scope: Schema.String,
  action: Schema.Literals(["pause", "resume", "stop"]),
  by: Schema.String,
  // Tasks the action interrupted or cancelled.
  tasks: Schema.Array(TaskId),
})

// What went into the context of one run: ids and counts, never the text. `budget` is the room left after the
// answer reserve; `dropped` lists the blocks that lost items to fit it.
export const ContextAssembledPayload = Schema.Struct({
  taskId: TaskId,
  level: Schema.Literals(["none", "top3", "full"]),
  used: Schema.Int,
  budget: Schema.Int,
  dropped: Schema.Array(Schema.Struct({ block: Schema.String, items: Schema.Int })),
})
