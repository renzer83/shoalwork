import { Effect, Schema } from "effect"
import { Budget } from "./budget.js"
import { ModelTier, TaskKind, TaskOrigin } from "./enums.js"
import { BotId, PlanId, StepId, TaskId } from "./ids.js"

export const RepoRef = Schema.Struct({
  url: Schema.String,
  base: Schema.String, // branch
})
export type RepoRef = typeof RepoRef.Type

export const ArtifactKind = Schema.Literals(["file", "pr", "text", "url"])
export type ArtifactKind = typeof ArtifactKind.Type

export const Artifact = Schema.Struct({
  kind: ArtifactKind,
  ref: Schema.String,
  summary: Schema.optional(Schema.String),
})
export type Artifact = typeof Artifact.Type

export const TaskSpec = Schema.Struct({
  id: TaskId,
  botId: BotId,
  title: Schema.String,
  prompt: Schema.String,
  kind: TaskKind,
  repo: Schema.optional(RepoRef),
  // Commands or natural-language criteria. Missing key decodes to [].
  acceptance: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  budget: Budget,
  tier: ModelTier,
  origin: TaskOrigin,
  parent: Schema.optional(Schema.Struct({ planId: PlanId, stepId: StepId })),
})
export type TaskSpec = typeof TaskSpec.Type
