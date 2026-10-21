import { Schema } from "effect"

// The export contract of the Dev Factory bridge (store SQLite). `source` is always "bridge-sqlite" today; the field
// is the idempotency namespace so a second provider could coexist without colliding on (source, id).
export const ProjectExport = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  repoUrl: Schema.String,
  defaultBranch: Schema.String,
  status: Schema.Literals(["active", "maintenance", "done"]),
})
export type ProjectExport = typeof ProjectExport.Type

// The SOULs of the factory. Validated here but not stored by the importer: they are the procedural memory and the
// Bot templates imported by T-059 / T-038.
export const AgentExport = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  model: Schema.optional(Schema.String),
  instructionsPath: Schema.optional(Schema.String),
})
export type AgentExport = typeof AgentExport.Type

export const TaskExport = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  title: Schema.String,
  issueNumber: Schema.optional(Schema.Int),
  prNumber: Schema.optional(Schema.Int),
  state: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.optional(Schema.DateTimeUtcFromString),
  mergedAt: Schema.optional(Schema.DateTimeUtcFromString),
  closedAt: Schema.optional(Schema.DateTimeUtcFromString),
  retries: Schema.Int,
  manualInterventions: Schema.Int,
  tokensIn: Schema.optional(Schema.Int),
  tokensOut: Schema.optional(Schema.Int),
  usd: Schema.optional(Schema.Number),
})
export type TaskExport = typeof TaskExport.Type

// A free-form event of one task. `type` is a string because the bridge store does not share the Beacon taxonomy.
export const FactoryEventExport = Schema.Struct({
  taskId: Schema.String,
  type: Schema.String,
  at: Schema.DateTimeUtcFromString,
  data: Schema.optional(Schema.Unknown),
})
export type FactoryEventExport = typeof FactoryEventExport.Type

export const FactoryExport = Schema.Struct({
  exportedAt: Schema.DateTimeUtcFromString,
  source: Schema.Literal("bridge-sqlite"),
  projects: Schema.Array(ProjectExport),
  agents: Schema.Array(AgentExport),
  tasks: Schema.Array(TaskExport),
  events: Schema.Array(FactoryEventExport),
})
export type FactoryExport = typeof FactoryExport.Type
