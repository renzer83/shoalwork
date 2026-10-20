import type { BeaconShape } from "@shoalwork/beacon"
import { EventPayloads } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"

// The dataset keeps the start of the prompt and never a user identifier (ADR-003).
export const DATASET_TEXT_MAX = 500

const DecisionMade = EventPayloads["decision.made"]
const DecisionOutcome = EventPayloads["decision.outcome"]

// Decoding drops every key not declared here: userId, correlationId and routing never leave the system.
const DatasetFacts = Schema.Struct({
  text: Schema.String,
  channel: Schema.String,
  hasRepo: Schema.Boolean,
  language: Schema.optionalKey(Schema.String),
  botHint: Schema.optionalKey(Schema.String),
  bots: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, role: Schema.String })),
  executors: Schema.Array(Schema.Struct({ id: Schema.String, available: Schema.Boolean })),
})

export type DatasetOutcome = typeof DecisionOutcome.Type.outcome

// One line of the JSONL export: the decision, the answer it gave and the outcome that closed it.
export interface DatasetRow {
  readonly decisionId: string
  readonly facts: typeof DatasetFacts.Type
  readonly question: { readonly id: string; readonly kind: "noul" | "choice" | "score" }
  readonly answer: {
    readonly value: boolean | string | number
    readonly confidence: number
    readonly source: "rule" | "model" | "cache"
  }
  readonly outcome: DatasetOutcome
  readonly note?: string
}

// Last outcome per decisionId, in log order: a correction appends a newer outcome.
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

// Joins each decision.made with its last decision.outcome. Decisions without an outcome are skipped.
export const exportDataset = (beacon: BeaconShape): Stream.Stream<DatasetRow, SqlError> =>
  Stream.fromIterableEffect(
    Effect.gen(function* () {
      const decided = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["decision.made"])))
      const outcomes = yield* latestOutcomes(beacon)
      const rows: Array<DatasetRow> = []
      for (const event of decided) {
        const payload = yield* Schema.decodeUnknownEffect(DecisionMade)(event.payload).pipe(Effect.orDie)
        const settled = outcomes.get(payload.decisionId)
        if (settled === undefined) {
          continue
        }
        const facts = yield* Schema.decodeUnknownEffect(DatasetFacts)(payload.facts).pipe(Effect.orDie)
        rows.push({
          decisionId: payload.decisionId,
          facts: { ...facts, text: facts.text.slice(0, DATASET_TEXT_MAX) },
          question: { id: payload.questionId, kind: payload.kind },
          answer: { value: payload.value, confidence: payload.confidence, source: payload.source },
          outcome: settled.outcome,
          ...(settled.note === undefined ? {} : { note: settled.note }),
        })
      }
      return rows
    }),
  )

// One JSON object per line, newline-terminated.
export const toNdjsonLine = (row: DatasetRow): string => `${JSON.stringify(row)}\n`
