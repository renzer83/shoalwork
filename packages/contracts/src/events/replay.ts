import { Schema } from "effect"
import { ModelTier } from "../enums.js"
import { ExecutorId, TaskId } from "../ids.js"

// What a replay may change about the run. The executor must be one the Bot already allows and the model a plain model
// name (it goes into argv): the Lead checks both again when the run starts.
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/

export const ReplayOverrides = Schema.Struct({
  executor: Schema.optionalKey(ExecutorId),
  tier: Schema.optionalKey(ModelTier),
  model: Schema.optionalKey(Schema.String.check(Schema.isPattern(MODEL_NAME_PATTERN))),
})
export type ReplayOverrides = typeof ReplayOverrides.Type

// A git object name, as `git rev-parse HEAD` prints it.
export const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/
export const GitSha = Schema.String.check(Schema.isPattern(GIT_SHA_PATTERN))

// A replay was started: the new task is linked to the one it re-runs. Ids and switches only, never the context text.
export const ReplayCreatedPayload = Schema.Struct({
  replayId: Schema.String,
  replayOf: TaskId,
  taskId: TaskId,
  overrides: ReplayOverrides,
  // The base commit the run starts from; absent when the source never recorded one.
  baseSha: Schema.optionalKey(GitSha),
  // True when the new run reuses the context text the source run was given.
  contextFrozen: Schema.Boolean,
})
export type ReplayCreatedPayload = typeof ReplayCreatedPayload.Type
