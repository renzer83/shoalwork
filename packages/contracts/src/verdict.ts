import { Schema } from "effect"
import { VerdictKind } from "./enums.js"
import { SessionId } from "./ids.js"

export const VerdictCost = Schema.Struct({
  tokensIn: Schema.Int,
  tokensOut: Schema.Int,
  usd: Schema.Number,
  seconds: Schema.Int,
})
export type VerdictCost = typeof VerdictCost.Type

export const Verdict = Schema.Struct({
  kind: VerdictKind,
  summary: Schema.String,
  // Short strings only: long logs belong in artifacts, not in the verdict.
  evidence: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  cost: VerdictCost,
  sessionId: Schema.optional(SessionId),
})
export type Verdict = typeof Verdict.Type
