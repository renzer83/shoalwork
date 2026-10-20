import { Schema } from "effect"

export const DecisionMadePayload = Schema.Struct({
  decisionId: Schema.String,
  questionId: Schema.String,
  kind: Schema.Literals(["noul", "choice", "score"]),
  value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]),
  confidence: Schema.Number,
  source: Schema.Literals(["rule", "model", "cache"]),
  facts: Schema.Record(Schema.String, Schema.Unknown),
})

export const DecisionOutcomePayload = Schema.Struct({
  decisionId: Schema.String,
  outcome: Schema.Literals(["correct", "corrected_by_human", "escalated", "unknown"]),
  note: Schema.optional(Schema.String),
})
