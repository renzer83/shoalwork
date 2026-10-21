import type { BeaconShape } from "@shoalwork/beacon"
import {
  type Conflict,
  EventPayloads,
  type NewEvent,
  NotFound,
  SchemaViolation,
  streamIds,
  type TaskState,
} from "@shoalwork/contracts"
import {
  type AnswerValue,
  fitsKind,
  fitsQuestion,
  formatCorrection,
  parseCorrection,
  STANDARD_QUESTIONS,
} from "@shoalwork/reflex"
import { Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { ACTOR } from "./verdict.js"

// Questions a finished task confirms. Everything else (complexity, risk, language...) has no evidence here.
const CONFIRMED_QUESTIONS: ReadonlySet<string> = new Set(["intent", "owner", "executor"])

const DecisionMade = EventPayloads["decision.made"]
const DecisionOutcome = EventPayloads["decision.outcome"]

// Renan's correction: free text kept as written, or the value he picked for the question (validated, then stored
// as "-> <valor>" so the export can read it back).
export type HumanCorrection =
  | { readonly kind: "text"; readonly note: string }
  | { readonly kind: "value"; readonly value: AnswerValue }

// The bots and executors a decision was answered against. Owner and executor options come from them.
const RosterFacts = Schema.Struct({
  bots: Schema.Array(Schema.Struct({ id: Schema.String })),
  executors: Schema.Array(Schema.Struct({ id: Schema.String })),
})

export const isTerminal = (state: TaskState): boolean =>
  state === "done" || state === "failed" || state === "cancelled"

// Pure: the automatic outcome of one decision when its task reaches a terminal state. Only "done" (an ok verdict)
// confirms the routing questions; failed, cancelled and every other question stay unknown.
export const outcomeFor = (questionId: string, state: TaskState): "correct" | "unknown" =>
  state === "done" && CONFIRMED_QUESTIONS.has(questionId) ? "correct" : "unknown"

interface DecisionRow {
  readonly correlationId: string
  readonly payload: typeof DecisionMade.Type
}

// Every decision.made, in log order. The type index serves the scan; correlation is filtered by the caller.
const readDecisions = (beacon: BeaconShape): Effect.Effect<ReadonlyArray<DecisionRow>, SqlError> =>
  Effect.gen(function* () {
    const events = yield* Stream.runCollect(beacon.readAll(0, ["decision.made"]))
    return yield* Effect.forEach(Array.from(events), (event) =>
      Schema.decodeUnknownEffect(DecisionMade)(event.payload).pipe(
        Effect.map((payload): DecisionRow => ({ correlationId: event.correlationId, payload })),
        Effect.orDie,
      ),
    )
  })

// Last outcome written per decisionId: a correction appends a newer outcome instead of rewriting the first one.
const latestOutcomes = (
  beacon: BeaconShape,
): Effect.Effect<ReadonlyMap<string, typeof DecisionOutcome.Type>, SqlError> =>
  Effect.gen(function* () {
    const events = yield* Stream.runCollect(beacon.readAll(0, ["decision.outcome"]))
    const latest = new Map<string, typeof DecisionOutcome.Type>()
    for (const event of Array.from(events)) {
      const payload = yield* Schema.decodeUnknownEffect(DecisionOutcome)(event.payload).pipe(Effect.orDie)
      latest.set(payload.decisionId, payload)
    }
    return latest
  })

const outcomeEvent = (
  correlationId: string,
  decisionId: string,
  outcome: typeof DecisionOutcome.Type.outcome,
  note?: string,
): NewEvent => ({
  streamId: streamIds.system,
  type: "decision.outcome",
  payload: { decisionId, outcome, ...(note === undefined ? {} : { note }) },
  actor: ACTOR,
  correlationId,
})

// The note a correction stores. A value must fit the question it answers; free text must not read as a value,
// or the export would take it for one.
const correctionNote = (
  decision: DecisionRow,
  correction: HumanCorrection,
): Effect.Effect<string, SchemaViolation> =>
  Effect.gen(function* () {
    if (correction.kind === "text") {
      if (Option.isSome(parseCorrection(correction.note))) {
        return yield* Effect.fail(new SchemaViolation({ where: "correction.note", issue: correction.note }))
      }
      return correction.note
    }
    const roster = yield* Schema.decodeUnknownEffect(RosterFacts)(decision.payload.facts).pipe(Effect.orDie)
    const standard = STANDARD_QUESTIONS.find((question) => question.id === decision.payload.questionId)
    const fits =
      standard === undefined
        ? fitsKind(decision.payload.kind, correction.value)
        : fitsQuestion(standard, correction.value, roster)
    if (!fits) {
      return yield* Effect.fail(new SchemaViolation({ where: "correction.value", issue: correction.value }))
    }
    return formatCorrection(correction.value)
  })

// Outcomes of the Reflex decisions that belong to a task: those whose correlationId is the id of the message that
// originated it (TaskSpec.correlationId) or, as a fallback, the task id itself. Called by the lifecycle on the
// terminal transition; a decision that already has an outcome is left alone.
export const makeOutcomes = (beacon: BeaconShape) => {
  const recordTaskOutcomes = (
    correlationIds: string | ReadonlyArray<string>,
    state: TaskState,
  ): Effect.Effect<number, SqlError | Conflict | SchemaViolation> =>
    Effect.gen(function* () {
      const wanted = typeof correlationIds === "string" ? [correlationIds] : correlationIds
      const decisions = (yield* readDecisions(beacon)).filter((row) => wanted.includes(row.correlationId))
      if (decisions.length === 0) {
        return 0
      }
      const settled = yield* latestOutcomes(beacon)
      const pending = decisions.filter((row) => !settled.has(row.payload.decisionId))
      if (pending.length === 0) {
        return 0
      }
      yield* beacon.appendMany(
        pending.map((row) =>
          outcomeEvent(row.correlationId, row.payload.decisionId, outcomeFor(row.payload.questionId, state)),
        ),
      )
      return pending.length
    })

  // Renan's correction of a decision. Returns false when the decision was already corrected by a human.
  // A value that does not fit its question fails with SchemaViolation and writes nothing.
  const recordHumanCorrection = (
    decisionId: string,
    correction: HumanCorrection,
  ): Effect.Effect<boolean, NotFound | SqlError | Conflict | SchemaViolation> =>
    Effect.gen(function* () {
      const decision = (yield* readDecisions(beacon)).find((row) => row.payload.decisionId === decisionId)
      if (decision === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Decision", id: decisionId }))
      }
      const note = yield* correctionNote(decision, correction)
      const settled = yield* latestOutcomes(beacon)
      if (settled.get(decisionId)?.outcome === "corrected_by_human") {
        return false
      }
      yield* beacon.append(outcomeEvent(decision.correlationId, decisionId, "corrected_by_human", note))
      return true
    })

  return { recordTaskOutcomes, recordHumanCorrection }
}

export type Outcomes = ReturnType<typeof makeOutcomes>
