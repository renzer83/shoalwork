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

// A code candidate the ranker considered for a briefing: its signals after min-max inside the batch, in the order bm25,
// cosine, recency, imports, success, proximity, and whether it went into the briefing. The weekly tuning re-ranks
// these offline.
export const RankedCandidatePayload = Schema.Struct({
  id: Schema.String,
  used: Schema.Boolean,
  signals: Schema.Tuple([
    Schema.Number,
    Schema.Number,
    Schema.Number,
    Schema.Number,
    Schema.Number,
    Schema.Number,
  ]),
})

// What went into the context of one run: ids and counts, never the text. `budget` is the room left after the
// answer reserve; `dropped` lists the blocks that lost items to fit it. `ranked` is present when the code was ranked.
// `tokenSource` says how the counts were made: "approx" (computed) or "mixed" (some answered from the cache, T-095).
// Absent in events written before it existed.
export const ContextAssembledPayload = Schema.Struct({
  taskId: TaskId,
  level: Schema.Literals(["none", "top3", "full"]),
  used: Schema.Int,
  budget: Schema.Int,
  dropped: Schema.Array(Schema.Struct({ block: Schema.String, items: Schema.Int })),
  ranked: Schema.optionalKey(Schema.Array(RankedCandidatePayload)),
  tokenSource: Schema.optionalKey(Schema.Literals(["approx", "mixed"])),
})

const RankWeightsPayload = Schema.Struct({
  bm25: Schema.Number,
  cosine: Schema.Number,
  recency: Schema.Number,
  imports: Schema.Number,
  success: Schema.Number,
  proximity: Schema.Number,
})

// The weekly rank-tune stored new ranking weights.
export const ContextWeightsUpdatedPayload = Schema.Struct({
  before: RankWeightsPayload,
  after: RankWeightsPayload,
  samples: Schema.Int,
  objectiveBefore: Schema.Number,
  objectiveAfter: Schema.Number,
})
