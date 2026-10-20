import { type Beacon, type CostBy, type CostWindow, costReport, readCostEvents } from "@shoalwork/beacon"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const DEFAULT_SINCE_DAYS = 7
// Caps the arithmetic: a relative bound never reaches back past 100 years.
const MAX_RELATIVE_AMOUNT = 36_500
const RELATIVE_BOUND = /^(\d+)([hd])$/
// Effect's date decoder also takes "7" or "March 7"; only the ISO shape is accepted as an absolute bound.
const ISO_BOUND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const BY_VALUES: ReadonlyArray<CostBy> = ["task", "bot", "executor"]

const parseBy = (raw: string): CostBy | undefined => BY_VALUES.find((value) => value === raw)

interface CostsQuery {
  readonly by: CostBy
  readonly current: CostWindow
  readonly baseline: CostWindow | undefined
}

// A bound is ISO-8601 UTC, or relative to `now` as "<n>h" / "<n>d". Anything else is undefined.
export const parseBound = (raw: string, now: number): number | undefined => {
  const relative = RELATIVE_BOUND.exec(raw)
  if (relative !== null) {
    const [, digits = "", unit = ""] = relative
    const amount = Number(digits)
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_RELATIVE_AMOUNT) return undefined
    return now - amount * (unit === "d" ? DAY_MS : HOUR_MS)
  }
  if (!ISO_BOUND.test(raw)) return undefined
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(raw))
  return parsed === undefined ? undefined : DateTime.toEpochMillis(parsed)
}

const invalidQuery = (param: string): RouteResponse => ({
  status: 400,
  body: { error: "invalid query", param },
})

interface RawParams {
  readonly by: string | undefined
  readonly since: string | undefined
  readonly until: string | undefined
  readonly compareWith: string | undefined
}

// Hand-checked like the events query: the errors name the parameter. The baseline ends where the current window
// starts, so `compareWith=14d&since=7d` compares the 7 days before the last 7 days with the last 7 days.
export const parseCostsQuery = (
  params: RawParams,
  now: number,
):
  | { readonly ok: true; readonly query: CostsQuery }
  | { readonly ok: false; readonly response: RouteResponse } => {
  const by = params.by === undefined ? "task" : parseBy(params.by)
  if (by === undefined) {
    return { ok: false, response: invalidQuery("by") }
  }
  const since = params.since === undefined ? now - DEFAULT_SINCE_DAYS * DAY_MS : parseBound(params.since, now)
  if (since === undefined) {
    return { ok: false, response: invalidQuery("since") }
  }
  const until = params.until === undefined ? now : parseBound(params.until, now)
  if (until === undefined || until <= since) {
    return { ok: false, response: invalidQuery("until") }
  }
  const current: CostWindow = { since, until }
  if (params.compareWith === undefined) {
    return { ok: true, query: { by, current, baseline: undefined } }
  }
  const compareFrom = parseBound(params.compareWith, now)
  if (compareFrom === undefined || compareFrom >= since) {
    return { ok: false, response: invalidQuery("compareWith") }
  }
  return { ok: true, query: { by, current, baseline: { since: compareFrom, until: since } } }
}

// One read of the cost events; both windows are cut from it. The body is the CostReport: { rows, delta }.
const readCosts = (query: CostsQuery): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const events = yield* readCostEvents()
    const report = costReport(events, { current: query.current, baseline: query.baseline }, query.by)
    return { status: 200, body: report } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerCostRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/costs", async (c) => {
    const parsed = parseCostsQuery(
      {
        by: c.req.query("by"),
        since: c.req.query("since"),
        until: c.req.query("until"),
        compareWith: c.req.query("compareWith"),
      },
      Date.now(),
    )
    if (!parsed.ok) {
      return sendResponse(c, parsed.response)
    }
    return sendResponse(c, await runEffect(readCosts(parsed.query)))
  })
}
