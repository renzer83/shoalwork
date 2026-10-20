import type { BeaconShape } from "@shoalwork/beacon"
import {
  type Conflict,
  EventPayloads,
  type NewEvent,
  NotFound,
  type SchemaViolation,
  streamIds,
  type TaskState,
} from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { ACTOR } from "./verdict.js"

// Questions a finished task confirms. Everything else (complexity, risk, language...) has no evidence here.
const CONFIRMED_QUESTIONS: ReadonlySet<string> = new Set(["intent", "owner", "executor"])

const DecisionMade = EventPayloads["decision.made"]
const DecisionOutcome = EventPayloads["decision.outcome"]

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

// Outcomes of the Reflex decisions that share the task's correlationId (the task's own events carry taskId).
// Called by the lifecycle on the terminal transition; a decision that already has an outcome is left alone.
export const makeOutcomes = (beacon: BeaconShape) => {
  const recordTaskOutcomes = (
    correlationId: string,
    state: TaskState,
  ): Effect.Effect<number, SqlError | Conflict | SchemaViolation> =>
    Effect.gen(function* () {
      const decisions = (yield* readDecisions(beacon)).filter((row) => row.correlationId === correlationId)
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
          outcomeEvent(correlationId, row.payload.decisionId, outcomeFor(row.payload.questionId, state)),
        ),
      )
      return pending.length
    })

  // Renan's correction of a decision. Returns false when the decision was already corrected by a human.
  const recordHumanCorrection = (
    decisionId: string,
    note: string,
  ): Effect.Effect<boolean, NotFound | SqlError | Conflict | SchemaViolation> =>
    Effect.gen(function* () {
      const decision = (yield* readDecisions(beacon)).find((row) => row.payload.decisionId === decisionId)
      if (decision === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Decision", id: decisionId }))
      }
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
