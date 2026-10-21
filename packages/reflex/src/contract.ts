import type { BotId, ExecutorId } from "@shoalwork/contracts"
import { Option } from "effect"

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

// The bots and executors a decision was answered against: the owner and executor options come from them.
export interface Roster {
  readonly bots: ReadonlyArray<{ readonly id: string }>
  readonly executors: ReadonlyArray<{ readonly id: string }>
}

type ChoiceQuestion = Extract<Question, { readonly kind: "choice" }>

// Static options when the question declares them. Owner and executor declare none: their options come from the roster.
// Any other choice without options accepts any string (undefined).
export const choiceOptions = (
  question: ChoiceQuestion,
  roster: Roster,
): ReadonlyArray<string> | undefined => {
  if (question.options.length > 0) {
    return question.options
  }
  if (question.id === "owner") {
    return [...roster.bots.map((bot) => bot.id), "new"]
  }
  if (question.id === "executor") {
    return [...roster.executors.map((executor) => executor.id), "none"]
  }
  return undefined
}

// A value fits the question when its type matches the kind (and the scale or the options).
export const fitsQuestion = (question: Question, value: AnswerValue, roster: Roster): boolean => {
  if (question.kind === "noul") {
    return typeof value === "boolean"
  }
  if (question.kind === "score") {
    return typeof value === "number" && value >= question.scale[0] && value <= question.scale[1]
  }
  const options = choiceOptions(question, roster)
  return typeof value === "string" && (options === undefined || options.includes(value))
}

// Type check only, for a question the contract does not declare: there are no options or scale to compare with.
export const fitsKind = (kind: Question["kind"], value: AnswerValue): boolean => {
  if (kind === "noul") {
    return typeof value === "boolean"
  }
  if (kind === "score") {
    return typeof value === "number"
  }
  return typeof value === "string"
}

// A human correction that names the value writes "-> <valor>" as its note. Free text carries no mark.
export const CORRECTION_MARK = "->"

export const formatCorrection = (value: AnswerValue): string => `${CORRECTION_MARK} ${String(value)}`

// Pure and linear: one prefix test and one trim. Returns the raw value text; coerceCorrection types it.
export const parseCorrection = (note: string): Option.Option<string> => {
  if (!note.startsWith(CORRECTION_MARK)) {
    return Option.none()
  }
  const raw = note.slice(CORRECTION_MARK.length).trim()
  return raw === "" ? Option.none() : Option.some(raw)
}

// The raw value typed by the kind of its question; undefined when the text does not read as that kind.
export const coerceCorrection = (raw: string, kind: Question["kind"]): AnswerValue | undefined => {
  if (raw === "") {
    return undefined
  }
  if (kind === "noul") {
    if (raw === "true") {
      return true
    }
    return raw === "false" ? false : undefined
  }
  if (kind === "score") {
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  return raw
}
