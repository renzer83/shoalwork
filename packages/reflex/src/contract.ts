import type { BotId, ExecutorId } from "@shoalwork/contracts"

export type Channel = "telegram" | "api" | "cli" | "tide"

export type Intent = "chat" | "system" | "code" | "research" | "app_op" | "routine"

export type Language = "pt" | "en" | "es" | "other"

// `routing` is an optional extension: the owner Bot's executor preferences, needed by the executor question.
export type Facts = {
  text: string
  channel: Channel
  userId: string
  botHint?: BotId
  bots: ReadonlyArray<{
    id: BotId
    name: string
    role: string
    routing?: { preferred: ReadonlyArray<ExecutorId>; allowed: ReadonlyArray<ExecutorId> }
  }>
  executors: ReadonlyArray<{ id: ExecutorId; available: boolean }>
  hasRepo: boolean
  language?: string
  // Groups the decisions of one ask (e.g. the id of the message). Each ask without it gets a fresh id.
  correlationId?: string
}

export type Question =
  | { readonly id: string; readonly kind: "noul" }
  | { readonly id: string; readonly kind: "choice"; readonly options: ReadonlyArray<string> }
  | { readonly id: string; readonly kind: "score"; readonly scale: readonly [number, number] }

export type AnswerValue = boolean | string | number

export interface Answer {
  readonly id: string
  readonly value: AnswerValue
  readonly confidence: number
  readonly source: "rule" | "model" | "cache"
}

export type AnswerRecord = Answer & { readonly decisionId: string }

// Question ids of the standard set. `owner` and `executor` options depend on the facts, so they are empty here.
export const STANDARD_QUESTIONS: ReadonlyArray<Question> = [
  { id: "intent", kind: "choice", options: ["chat", "system", "code", "research", "app_op", "routine"] },
  { id: "complexity", kind: "score", scale: [0, 4] },
  { id: "owner", kind: "choice", options: [] },
  { id: "executor", kind: "choice", options: [] },
  { id: "parallelizable", kind: "noul" },
  { id: "risk", kind: "score", scale: [0, 3] },
  { id: "needs_approval", kind: "noul" },
  { id: "language", kind: "choice", options: ["pt", "en", "es", "other"] },
]

export const STANDARD_IDS = [
  "intent",
  "complexity",
  "owner",
  "executor",
  "parallelizable",
  "risk",
  "needs_approval",
  "language",
] as const

export type StandardQuestionId = (typeof STANDARD_IDS)[number]

export interface Scored<V> {
  readonly value: V
  readonly confidence: number
}

export interface StandardDecision {
  readonly intent: Intent
  readonly complexity: number
  readonly owner: BotId | "new"
  readonly executor: ExecutorId | "none"
  readonly parallelizable: boolean
  readonly risk: number
  readonly needsApproval: boolean
  readonly language: Language
  readonly answers: ReadonlyArray<AnswerRecord>
}
