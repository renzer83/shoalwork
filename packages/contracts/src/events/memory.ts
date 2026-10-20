import { Schema } from "effect"

// Memory events carry ids and labels, never the content: the log is not a second copy of the memory.
export const MemoryScopeLabel = Schema.Literals(["bot", "pod", "global"])

export const MemoryAddedPayload = Schema.Struct({
  id: Schema.String,
  scope: MemoryScopeLabel,
  ownerId: Schema.String,
  kind: Schema.Literals(["working", "episodic", "semantic", "procedural"]),
  source: Schema.String,
})

export const MemorySupersededPayload = Schema.Struct({
  id: Schema.String,
  supersededBy: Schema.String,
  scope: MemoryScopeLabel,
  ownerId: Schema.String,
})

export const MemoryForgottenPayload = Schema.Struct({
  id: Schema.String,
  scope: MemoryScopeLabel,
  ownerId: Schema.String,
})
