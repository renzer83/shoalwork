import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type NewEvent, newEventId, streamIds } from "@shoalwork/contracts"
import { Context, Effect, Layer } from "effect"
import type { ReflexConfig } from "./config.js"
import {
  type AnswerRecord,
  type AnswerValue,
  choiceOptions,
  type Facts,
  fitsQuestion,
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

// Neutral value of the right type, used with confidence 0 when no rule answers or the answer does not fit.
export const neutralFor = (question: Question, facts: Facts): AnswerValue => {
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
  if (scored !== undefined && fitsQuestion(question, scored.value, facts)) {
    return { value: scored.value, confidence: scored.confidence }
  }
  return { value: neutralFor(question, facts), confidence: 0 }
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...[truncated]`

// One decision.made per answer, appended as one batch. Each row keeps its own decision id.
// A failed write is logged and the caller goes on: the answers are returned anyway.
export const recordDecisions = (
  beacon: BeaconShape,
  payloadChars: number,
  correlationId: string,
  facts: Facts,
  rows: ReadonlyArray<{ readonly question: Question; readonly record: AnswerRecord }>,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (rows.length === 0) {
      return
    }
    const payloadFacts = { ...facts, text: truncate(facts.text, payloadChars) }
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
  })

// Each decision is a fresh evt_ id; Beacon assigns the stored event id itself, so the two differ.
const decideAndRecord = (
  beacon: BeaconShape,
  c: CompiledRules,
  facts: Facts,
  questions: ReadonlyArray<Question>,
): Effect.Effect<{ readonly scores: StandardScores; readonly records: ReadonlyArray<AnswerRecord> }, never> =>
  Effect.gen(function* () {
    const scores = scoreAll(facts, c)
    const correlationId = facts.correlationId ?? newEventId()
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
    yield* recordDecisions(beacon, c.payloadChars, correlationId, facts, rows)
    return { scores, records: rows.map((row) => row.record) }
  })

// The v0 rules as a Reflex shape over a Beacon: the fallback of the HTTP backend, and the whole of ReflexRulesLive.
export const makeReflex = (beacon: BeaconShape, c: CompiledRules): ReflexShape => ({
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
