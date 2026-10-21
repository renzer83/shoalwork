import { ReplayOverrides, TaskState, Verdict } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { ApiClient } from "./client.js"

// The replay routes (T-122). Shapes mirror the core's routes/replay.ts and packages/lead replay-compare.ts.
export const ReplayStarted = Schema.Struct({
  replay: Schema.Struct({
    id: Schema.String,
    sourceTaskId: Schema.String,
    taskId: Schema.String,
    overrides: ReplayOverrides,
    baseSha: Schema.NullOr(Schema.String),
    contextFrozen: Schema.Boolean,
  }),
})
export type ReplayStarted = typeof ReplayStarted.Type

const RunSummary = Schema.Struct({
  taskId: Schema.String,
  state: TaskState,
  verdict: Schema.NullOr(Verdict),
  usage: Schema.Struct({
    tokensIn: Schema.Number,
    tokensOut: Schema.Number,
    usd: Schema.Number,
    seconds: Schema.Number,
  }),
  durationMs: Schema.Number,
  executor: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
})
export type RunSummary = typeof RunSummary.Type

export const ReplayComparison = Schema.Struct({
  id: Schema.String,
  sourceTaskId: Schema.String,
  newTaskId: Schema.String,
  overrides: ReplayOverrides,
  baseSha: Schema.NullOr(Schema.String),
  contextFrozen: Schema.Boolean,
  createdAt: Schema.String,
  source: RunSummary,
  replay: RunSummary,
  diff: Schema.Struct({
    verdictChanged: Schema.Boolean,
    usdDelta: Schema.Number,
    durationDeltaMs: Schema.Number,
    executorChanged: Schema.Boolean,
    modelChanged: Schema.Boolean,
    filesOnlyInSource: Schema.Array(Schema.String),
    filesOnlyInReplay: Schema.Array(Schema.String),
    evidenceOnlyInSource: Schema.Array(Schema.String),
    evidenceOnlyInReplay: Schema.Array(Schema.String),
  }),
  notes: Schema.Array(Schema.String),
})
export type ReplayComparison = typeof ReplayComparison.Type

export const replayApi = (client: ApiClient) => ({
  start: (taskId: string, overrides: typeof ReplayOverrides.Encoded = {}) =>
    client.post(`/tasks/${encodeURIComponent(taskId)}/replay`, overrides, ReplayStarted),
  compare: (replayId: string) => client.get(`/replays/${encodeURIComponent(replayId)}`, ReplayComparison),
})
