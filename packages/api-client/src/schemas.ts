import { Approval, Bot, BotState, Event, TaskSpec, TaskState, Tide, Verdict } from "@shoalwork/contracts"
import { Schema } from "effect"

// Response shapes of the core routes (02-architecture.md §12). Fields the app does not read are left out:
// a Struct ignores unknown keys when decoding.

export const HealthBody = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  db: Schema.Literals(["ok", "error"]),
  dbPath: Schema.NullOr(Schema.String),
  journalMode: Schema.NullOr(Schema.String),
  uptimeSeconds: Schema.Number,
})
export type HealthBody = typeof HealthBody.Type

export const BotSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  state: BotState,
})
export type BotSummary = typeof BotSummary.Type

export const BotList = Schema.Struct({ bots: Schema.Array(BotSummary) })
export const BotOne = Schema.Struct({ bot: BotSummary })

// The ficha: the full Bot definition plus the live state (GET /bots/:idOrName).
export const BotDetail = Schema.Struct({ ...Bot.fields, state: BotState })
export type BotDetail = typeof BotDetail.Type
export const BotDetailOne = Schema.Struct({ bot: BotDetail })

export const TaskView = Schema.Struct({
  spec: TaskSpec,
  state: TaskState,
  verdict: Schema.optional(Verdict),
})
export type TaskView = typeof TaskView.Type

export const TaskCreated = Schema.Struct({ task: Schema.Unknown })

export const EventList = Schema.Struct({ events: Schema.Array(Event) })

export const ApprovalList = Schema.Struct({ approvals: Schema.Array(Approval) })

export const ApprovalResolved = Schema.Struct({
  result: Schema.Literals(["resolved", "already"]),
  approval: Approval,
})
export type ApprovalResolved = typeof ApprovalResolved.Type

export const MemoryHit = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  ownerId: Schema.String,
  kind: Schema.String,
  content: Schema.String,
  score: Schema.optionalKey(Schema.Number),
})
export type MemoryHit = typeof MemoryHit.Type
export const MemoryHits = Schema.Array(MemoryHit)
// The list (GET /memory without q) carries no score; the search does.
export const MemoryItemOne = Schema.Struct({
  item: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
    ownerId: Schema.String,
    kind: Schema.String,
    content: Schema.String,
  }),
})
export const MemoryForgotten = Schema.Struct({ forgotten: Schema.String })

// One version of a memory item (GET /memory/:id/history): the chain of supersedes, oldest first.
export const MemoryVersion = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  supersededBy: Schema.NullOr(Schema.String),
  forgotten: Schema.Boolean,
})
export type MemoryVersion = typeof MemoryVersion.Type
export const MemoryHistory = Schema.Struct({ items: Schema.Array(MemoryVersion) })

export const ProjectSummary = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  repoUrl: Schema.String,
  defaultBranch: Schema.String,
  status: Schema.String,
  maxInProgress: Schema.Number,
  autoMerge: Schema.Boolean,
})
export type ProjectSummary = typeof ProjectSummary.Type
export const ProjectList = Schema.Struct({ projects: Schema.Array(ProjectSummary) })

export const TideList = Schema.Struct({ tides: Schema.Array(Tide) })

export const CostRow = Schema.Struct({
  key: Schema.String,
  n: Schema.Number,
  tokensIn: Schema.Number,
  tokensOut: Schema.Number,
  usd: Schema.Number,
  contextTokensAvg: Schema.NullOr(Schema.Number),
  okRate: Schema.NullOr(Schema.Number),
})
export const CostReport = Schema.Struct({
  rows: Schema.Array(CostRow),
  delta: Schema.Struct({
    tokensInPct: Schema.NullOr(Schema.Number),
    okRatePct: Schema.NullOr(Schema.Number),
  }),
})
export type CostReport = typeof CostReport.Type
