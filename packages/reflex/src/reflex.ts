import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type NewEvent, newEventId, streamIds } from "@shoalwork/contracts"
import { Context, Effect, Layer } from "effect"
import type { ReflexConfig } from "./config.js"
import {
  type AnswerRecord,
  type AnswerValue,
  type Facts,
  type Question,
  type Scored,
  STANDARD_IDS,
  STANDARD_QUESTIONS,
  type StandardDecision,
  type StandardQuestionId,
} from "./contract.js"
import { type CompiledRules, compileRules, type StandardScores, scoreAll } from "./rules.js"

export type ReflexShape = {
  readonly ask: (
    facts: Facts,
    questions?: ReadonlyArray<Question>,
  ) => Effect.Effect<ReadonlyArray<AnswerRecord>, never>
  readonly standard: (facts: Facts) => Effect.Effect<StandardDecision, never>
}

export class Reflex extends Context.Service<Reflex, ReflexShape>()("@shoalwork/Reflex") {}

const STANDARD_ID_SET: ReadonlySet<string> = new Set<string>(STANDARD_IDS)

const isStandardId = (id: string): id is StandardQuestionId => STANDARD_ID_SET.has(id)

const scoreOf = (scores: StandardScores, id: string): Scored<AnswerValue> | undefined =>
  isStandardId(id) ? scores[id] : undefined

type ChoiceQuestion = Extract<Question, { readonly kind: "choice" }>

// Static options when the question declares them. Owner and executor declare none: their options come from facts.
// Any other choice without options accepts any string (undefined).
const choiceOptions = (question: ChoiceQuestion, facts: Facts): ReadonlyArray<string> | undefined => {
  if (question.options.length > 0) {
    return question.options
  }
  if (question.id === "owner") {
    return [...facts.bots.map((bot) => bot.id), "new"]
  }
  if (question.id === "executor") {
    return [...facts.executors.map((e) => e.id), "none"]
  }
  return undefined
}

// A value fits the question when its type matches the kind (and the scale or the options).
const fits = (question: Question, value: AnswerValue, facts: Facts): boolean => {
  if (question.kind === "noul") {
    return typeof value === "boolean"
  }
  if (question.kind === "score") {
    return typeof value === "number" && value >= question.scale[0] && value <= question.scale[1]
  }
  const options = choiceOptions(question, facts)
  return typeof value === "string" && (options === undefined || options.includes(value))
}

// Neutral value of the right type, used with confidence 0 when no rule answers or the answer does not fit.
const neutralFor = (question: Question, facts: Facts): AnswerValue => {
  if (question.kind === "noul") {
    return false
  }
  if (question.kind === "score") {
    return question.scale[0]
  }
  return choiceOptions(question, facts)?.[0] ?? "unknown"
}

const resolve = (
  question: Question,
  scores: StandardScores,
  facts: Facts,
): { readonly value: AnswerValue; readonly confidence: number } => {
  const scored = scoreOf(scores, question.id)
  if (scored !== undefined && fits(question, scored.value, facts)) {
    return { value: scored.value, confidence: scored.confidence }
  }
  return { value: neutralFor(question, facts), confidence: 0 }
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...[truncated]`

// Each decision is a fresh evt_ id; Beacon assigns the stored event id itself, so the two differ.
// A failed write is logged and the answers are still returned: the caller must not die for it.
const decideAndRecord = (
  beacon: BeaconShape,
  c: CompiledRules,
  facts: Facts,
  questions: ReadonlyArray<Question>,
): Effect.Effect<{ readonly scores: StandardScores; readonly records: ReadonlyArray<AnswerRecord> }, never> =>
  Effect.gen(function* () {
    const scores = scoreAll(facts, c)
    const correlationId = facts.correlationId ?? newEventId()
    const payloadFacts = { ...facts, text: truncate(facts.text, c.payloadChars) }
    const rows = questions.map((question) => {
      const { value, confidence } = resolve(question, scores, facts)
      const record: AnswerRecord = {
        id: question.id,
        value,
        confidence,
        source: "rule",
        decisionId: newEventId(),
      }
      return { question, record }
    })
    if (rows.length > 0) {
      const events: ReadonlyArray<NewEvent> = rows.map(({ question, record }) => ({
        streamId: streamIds.system,
        type: "decision.made",
        payload: {
          decisionId: record.decisionId,
          questionId: record.id,
          kind: question.kind,
          value: record.value,
          confidence: record.confidence,
          source: record.source,
          facts: payloadFacts,
        },
        actor: "system:reflex",
        correlationId,
      }))
      yield* beacon
        .appendMany(events)
        .pipe(
          Effect.catchCause(() =>
            Effect.logError("reflex: decision.made not persisted; answers returned anyway"),
          ),
        )
    }
    return { scores, records: rows.map((row) => row.record) }
  })

const makeReflex = (beacon: BeaconShape, c: CompiledRules): ReflexShape => ({
  ask: (facts, questions = STANDARD_QUESTIONS) =>
    Effect.map(decideAndRecord(beacon, c, facts, questions), (decided) => decided.records),
  standard: (facts) =>
    Effect.map(decideAndRecord(beacon, c, facts, STANDARD_QUESTIONS), ({ scores, records }) => ({
      intent: scores.intent.value,
      complexity: scores.complexity.value,
      owner: scores.owner.value,
      executor: scores.executor.value,
      parallelizable: scores.parallelizable.value,
      risk: scores.risk.value,
      needsApproval: scores.needs_approval.value,
      language: scores.language.value,
      answers: records,
    })),
})

export const makeReflexLive = (config: ReflexConfig): Layer.Layer<Reflex, never, Beacon> =>
  Layer.effect(
    Reflex,
    Effect.gen(function* () {
      const beacon = yield* Beacon
      return makeReflex(beacon, compileRules(config))
    }),
  )
