import { Schema } from "effect"

// A limit is never negative, and never NaN or infinite: Schema.Number accepts both, and `x < 0` lets NaN through.
const Limit = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const Spend = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

export const Budget = Schema.Struct({ tokens: Limit, seconds: Limit, usd: Spend })
export type Budget = typeof Budget.Type

export const Usage = Schema.Struct({
  tokensIn: Schema.Int,
  tokensOut: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
  usd: Schema.Number,
  seconds: Schema.Int,
})
export type Usage = typeof Usage.Type

export const ZERO_USAGE: Usage = {
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 0,
  seconds: 0,
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  usd: a.usd + b.usd,
  seconds: a.seconds + b.seconds,
})

export const usageToBudget = (u: Usage): Budget => ({
  tokens: u.tokensIn + u.tokensOut,
  seconds: u.seconds,
  usd: u.usd,
})

export type BudgetDimension = "tokens" | "seconds" | "usd"

export const exceeds = (used: Budget, limit: Budget): { exceeded: boolean; by: Array<BudgetDimension> } => {
  const by: Array<BudgetDimension> = []
  if (used.tokens > limit.tokens) by.push("tokens")
  if (used.seconds > limit.seconds) by.push("seconds")
  if (used.usd > limit.usd) by.push("usd")
  return { exceeded: by.length > 0, by }
}
