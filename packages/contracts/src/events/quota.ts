import { Schema } from "effect"
import { ExecutorId } from "../ids.js"

// A person (or the API) set or cleared an executor's quota mark (T-075). `exhaustedUntil` is an ISO instant, or null
// when the mark was cleared. Only ever extends a window or clears the mark, so the value is the one asked for.
export const ExecutorQuotaAdjustedPayload = Schema.Struct({
  executor: ExecutorId,
  exhaustedUntil: Schema.NullOr(Schema.String),
  by: Schema.String,
})
export type ExecutorQuotaAdjustedPayload = typeof ExecutorQuotaAdjustedPayload.Type

// One stream per executor: its quota history reads back from here.
export const executorStreamId = (executor: string): string => `executor:${executor}`
