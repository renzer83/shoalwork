import {
  Beacon,
  COST_EVENT_TYPES,
  type ContextBy,
  type ContextDelta,
  type ContextMetricsRow,
  type ContextTotals,
  type CostWindow,
  contextDelta,
  contextRuns,
  contextTotals,
  groupContextRuns,
} from "@shoalwork/beacon"
import type { Event } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Hono } from "hono"
import { parseBound } from "./costs.js"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

const DAY_MS = 86_400_000
const DEFAULT_SINCE_DAYS = 7

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

// GET /costs/context (T-102). Rows of the current window grouped by `by`, and a comparison against either another
// window (ISO or relative) or the last `baselines` row of a project with metric tokens_per_task.
const CONTEXT_BY_VALUES: ReadonlyArray<ContextBy> = ["task", "bot", "executor", "level"]
const BASELINE_PREFIX = "baseline:"
const BASELINE_METRIC = "tokens_per_task"
const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type ContextCompare =
  | { readonly kind: "window"; readonly window: CostWindow }
  | { readonly kind: "baseline"; readonly project: string }

export interface ContextQuery {
  readonly by: ContextBy
  readonly current: CostWindow
  readonly compare: ContextCompare | undefined
}

// Same bounds rules as /costs. compareWith is "baseline:<project>" or a bound that ends where `since` starts.
export const parseContextQuery = (
  params: RawParams,
  now: number,
):
  | { readonly ok: true; readonly query: ContextQuery }
  | { readonly ok: false; readonly response: RouteResponse } => {
  const by = params.by === undefined ? "task" : CONTEXT_BY_VALUES.find((value) => value === params.by)
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
    return { ok: true, query: { by, current, compare: undefined } }
  }
  if (params.compareWith.startsWith(BASELINE_PREFIX)) {
    const project = params.compareWith.slice(BASELINE_PREFIX.length)
    if (!PROJECT_SLUG.test(project)) {
      return { ok: false, response: invalidQuery("compareWith") }
    }
    return { ok: true, query: { by, current, compare: { kind: "baseline", project } } }
  }
  const compareFrom = parseBound(params.compareWith, now)
  if (compareFrom === undefined || compareFrom >= since) {
    return { ok: false, response: invalidQuery("compareWith") }
  }
  return {
    ok: true,
    query: { by, current, compare: { kind: "window", window: { since: compareFrom, until: since } } },
  }
}

export interface BaselineValue {
  readonly value: number
  readonly windowFrom: string
  readonly windowTo: string
  readonly computedAt: string
}

export const CONTEXT_DEFINITION = {
  tokensIn:
    "usage.recorded.tokensIn somado por execução: entre executor.started e executor.finished do mesmo task+passo",
  okRate: "executor.finished com verdict ok / execuções",
  contextTokens: "used do último context.assembled da task antes do fim da execução",
  unpaired: "executor.finished sem executor.started no intervalo lido: fora das médias",
} as const

export const BASELINE_DEFINITION =
  "baselines.value de metric=tokens_per_task (factory computeBaseline: (tokens_in+tokens_out) por task em project_tasks); comparado com tokensIn por execução do janela atual: não é like-for-like"

export interface ContextCompareView {
  readonly kind: "window" | "baseline"
  readonly window?: { readonly since: string; readonly until: string }
  readonly totals?: ContextTotals
  readonly project?: string
  readonly metric?: string
  readonly value?: number
  readonly windowFrom?: string
  readonly windowTo?: string
  readonly computedAt?: string
  readonly definition?: string
}

export interface ContextCostsBody {
  readonly by: ContextBy
  readonly window: { readonly since: string; readonly until: string }
  readonly definition: typeof CONTEXT_DEFINITION
  readonly rows: ReadonlyArray<ContextMetricsRow>
  readonly totals: ContextTotals
  readonly unpaired: number
  readonly compare: ContextCompareView | null
  readonly delta: ContextDelta
  // Says why a comparison is missing or partial; null when everything asked for is there.
  readonly note: string | null
}

const isoOf = (ms: number): string => new Date(ms).toISOString()
const windowIso = (window: CostWindow): { readonly since: string; readonly until: string } => ({
  since: isoOf(window.since),
  until: isoOf(window.until),
})

// Pure: the body from the events of the union of the windows and the baseline row (undefined when there is none).
export const contextCostsBody = (
  events: ReadonlyArray<Event>,
  query: ContextQuery,
  baseline: BaselineValue | undefined,
): ContextCostsBody => {
  const current = contextRuns(events, query.current)
  const totals = contextTotals(current.runs)
  const base = {
    by: query.by,
    rows: groupContextRuns(current.runs, query.by),
    totals,
    unpaired: current.unpaired,
    definition: CONTEXT_DEFINITION,
    window: windowIso(query.current),
  }
  if (query.compare === undefined) {
    return { ...base, compare: null, delta: { tokensInAvgPct: null, okRatePct: null }, note: null }
  }
  if (query.compare.kind === "window") {
    const compareTotals = contextTotals(contextRuns(events, query.compare.window).runs)
    return {
      ...base,
      compare: { kind: "window", window: windowIso(query.compare.window), totals: compareTotals },
      delta: contextDelta(totals, compareTotals),
      note: null,
    }
  }
  const project = query.compare.project
  if (baseline === undefined) {
    return {
      ...base,
      compare: null,
      delta: { tokensInAvgPct: null, okRatePct: null },
      note: `no baselines row for project "${project}" with metric ${BASELINE_METRIC}; no comparison`,
    }
  }
  return {
    ...base,
    compare: {
      kind: "baseline",
      project,
      metric: BASELINE_METRIC,
      value: baseline.value,
      windowFrom: baseline.windowFrom,
      windowTo: baseline.windowTo,
      computedAt: baseline.computedAt,
      definition: BASELINE_DEFINITION,
    },
    delta: contextDelta(totals, { tokensInAvg: baseline.value, okRate: null }),
    note: "baseline has no okRate: okRatePct is null",
  }
}

const BaselineRow = Schema.Struct({
  value: Schema.Number,
  window_from: Schema.String,
  window_to: Schema.String,
  computed_at: Schema.String,
})
const decodeBaselineRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(BaselineRow))(rows).pipe(Effect.orDie)

// Latest tokens_per_task row of the project; the row is written by the factory baseline command.
const readBaseline = (project: string): Effect.Effect<BaselineValue | undefined, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT value, window_from, window_to, computed_at FROM baselines
      WHERE project = ${project} AND metric = ${BASELINE_METRIC}
      ORDER BY computed_at DESC, window_to DESC LIMIT 1`
    const [row] = yield* decodeBaselineRows(rows)
    return row === undefined
      ? undefined
      : {
          value: row.value,
          windowFrom: row.window_from,
          windowTo: row.window_to,
          computedAt: row.computed_at,
        }
  })

// One range read covers both windows: from the start of the comparison window to the end of the current one.
const readSpan = (query: ContextQuery): CostWindow =>
  query.compare?.kind === "window"
    ? { since: Math.min(query.current.since, query.compare.window.since), until: query.current.until }
    : query.current

const readContextCosts = (query: ContextQuery): Effect.Effect<RouteResponse, never, Beacon | SqlClient> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readRange(COST_EVENT_TYPES, readSpan(query)))
    let baseline: BaselineValue | undefined
    if (query.compare?.kind === "baseline") {
      baseline = yield* readBaseline(query.compare.project)
    }
    return { status: 200, body: contextCostsBody(events, query, baseline) } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerContextCostRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/costs/context", async (c) => {
    const parsed = parseContextQuery(
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
    return sendResponse(c, await runEffect(readContextCosts(parsed.query)))
  })
}
