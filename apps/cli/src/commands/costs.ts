import type { SchemaViolation } from "@shoalwork/contracts"
import { Console, Data, Effect, Schema } from "effect"
import { type Flags, parseArgs, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// `costs context --goal` exited with the verdict "not met". The table is already printed; the exit code carries the result.
export class GoalNotMet extends Data.TaggedError("GoalNotMet")<{ readonly message: string }> {}

// Mirrors the body of GET /costs (CostReport in packages/beacon/src/projections.ts).
const CostRow = Schema.Struct({
  key: Schema.String,
  n: Schema.Int,
  tokensIn: Schema.Int,
  tokensOut: Schema.Int,
  usd: Schema.Number,
  contextTokensAvg: Schema.NullOr(Schema.Number),
  okRate: Schema.NullOr(Schema.Number),
})

export const CostsBody = Schema.Struct({
  rows: Schema.Array(CostRow),
  delta: Schema.Struct({
    tokensInPct: Schema.NullOr(Schema.Number),
    okRatePct: Schema.NullOr(Schema.Number),
  }),
})
export type CostsBody = typeof CostsBody.Type

const BY_VALUES = ["task", "bot", "executor"] as const

// Builds the query string. `--compare` is the baseline start (ISO or relative), sent as compareWith.
export const costsQuery = (flags: Flags): Effect.Effect<URLSearchParams, UsageError> => {
  const by = flags.by ?? "task"
  if (!BY_VALUES.some((value) => value === by)) {
    return Effect.fail(new UsageError({ message: "--by expects task, bot or executor" }))
  }
  const params = new URLSearchParams({ by })
  if (flags.since !== undefined) params.set("since", flags.since)
  if (flags.compare !== undefined) params.set("compareWith", flags.compare)
  return Effect.succeed(params)
}

// GET /costs with the flags, decoded at the boundary.
export const costsReport = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<CostsBody, UsageError | HttpError | SchemaViolation> =>
  Effect.gen(function* () {
    const query = yield* costsQuery(flags)
    return yield* new ApiClient(settings.url, settings.token).get(`/costs?${query.toString()}`, CostsBody)
  })

// "n/d" = not available: no baseline window, or no execution on one side of the comparison.
const NOT_AVAILABLE = "n/d"
const MISSING = "-"

const signed = (value: number | null, unit: string): string =>
  value === null ? NOT_AVAILABLE : `${value >= 0 ? "+" : ""}${value.toFixed(1)}${unit}`

const TABLE_HEADER: ReadonlyArray<string> = ["key", "n", "tokensIn", "tokensOut", "usd", "ctxAvg", "okRate"]

// Left-aligned columns, two spaces apart; the widest cell of each column sets its width.
const formatTable = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  )
  return rows.map((row) =>
    row
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  )
}

// Plain text table, or the body as JSON with --json.
export const renderCosts = (body: CostsBody, json: boolean): string => {
  if (json) {
    return JSON.stringify(body, null, 2)
  }
  const lines = body.rows.map((row) => [
    row.key,
    String(row.n),
    String(row.tokensIn),
    String(row.tokensOut),
    row.usd.toFixed(4),
    row.contextTokensAvg === null ? MISSING : String(Math.round(row.contextTokensAvg)),
    row.okRate === null ? MISSING : `${(row.okRate * 100).toFixed(1)}%`,
  ])
  const table =
    body.rows.length === 0 ? ["no executions in the window"] : formatTable([TABLE_HEADER, ...lines])
  return [
    ...table,
    "",
    `tokensIn per execution vs baseline: ${signed(body.delta.tokensInPct, "%")}`,
    `okRate vs baseline: ${signed(body.delta.okRatePct, " pp")}`,
  ].join("\n")
}

// ---- costs context (T-102). Mirrors the body of GET /costs/context (ContextCostsBody in services/core routes/costs.ts).

const ContextRow = Schema.Struct({
  key: Schema.String,
  n: Schema.Int,
  tokensInAvg: Schema.Number,
  tokensInP90: Schema.Number,
  contextTokensAvg: Schema.NullOr(Schema.Number),
  okRate: Schema.Number,
})

export const ContextCostsBody = Schema.Struct({
  by: Schema.Literals(["task", "bot", "executor", "level"]),
  window: Schema.Struct({ since: Schema.String, until: Schema.String }),
  rows: Schema.Array(ContextRow),
  totals: Schema.Struct({
    n: Schema.Int,
    tokensInAvg: Schema.NullOr(Schema.Number),
    okRate: Schema.NullOr(Schema.Number),
  }),
  unpaired: Schema.Int,
  compare: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["window", "baseline"]),
      window: Schema.optionalKey(Schema.Struct({ since: Schema.String, until: Schema.String })),
      totals: Schema.optionalKey(
        Schema.Struct({
          n: Schema.Int,
          tokensInAvg: Schema.NullOr(Schema.Number),
          okRate: Schema.NullOr(Schema.Number),
        }),
      ),
      project: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.Number),
      windowFrom: Schema.optionalKey(Schema.String),
      windowTo: Schema.optionalKey(Schema.String),
      definition: Schema.optionalKey(Schema.String),
    }),
  ),
  delta: Schema.Struct({
    tokensInAvgPct: Schema.NullOr(Schema.Number),
    okRatePct: Schema.NullOr(Schema.Number),
  }),
  note: Schema.NullOr(Schema.String),
})
export type ContextCostsBody = typeof ContextCostsBody.Type

const CONTEXT_BY_VALUES = ["task", "bot", "executor", "level"] as const

// `--goal` is a fraction in (0, 1]: 0.40 means tokensIn per execution must fall by 40% or more.
export const parseGoal = (raw: string | undefined): Effect.Effect<number | undefined, UsageError> => {
  if (raw === undefined) return Effect.succeed(undefined)
  const goal = Number(raw)
  if (!Number.isFinite(goal) || goal <= 0 || goal > 1) {
    return Effect.fail(new UsageError({ message: "--goal expects a fraction in (0, 1], e.g. 0.40" }))
  }
  return Effect.succeed(goal)
}

export const contextQuery = (flags: Flags): Effect.Effect<URLSearchParams, UsageError> => {
  const by = flags.by ?? "task"
  if (!CONTEXT_BY_VALUES.some((value) => value === by)) {
    return Effect.fail(new UsageError({ message: "--by expects task, bot, executor or level" }))
  }
  const params = new URLSearchParams({ by })
  if (flags.since !== undefined) params.set("since", flags.since)
  if (flags.compare !== undefined) params.set("compareWith", flags.compare)
  return Effect.succeed(params)
}

export interface GoalVerdict {
  readonly met: boolean
  readonly reason: string
}

// Met when tokensIn per execution fell by at least `goal` and okRate did not fall. Without a comparison on either
// side the verdict is not met: the gate fails closed rather than passing on missing data.
export const goalVerdict = (body: ContextCostsBody, goal: number): GoalVerdict => {
  const { tokensInAvgPct, okRatePct } = body.delta
  if (tokensInAvgPct === null) {
    return { met: false, reason: body.note ?? "no comparison for tokensIn per execution" }
  }
  if (okRatePct === null) {
    return { met: false, reason: "okRate has no comparison" }
  }
  const tokensMet = tokensInAvgPct <= -goal * 100 + 1e-9
  const okMet = okRatePct >= 0
  const parts = `tokensIn ${signed(tokensInAvgPct, "%")}, okRate ${signed(okRatePct, " pp")}`
  if (!tokensMet) {
    return { met: false, reason: `${parts}; goal is <= ${(-goal * 100).toFixed(1)}%` }
  }
  if (!okMet) {
    return { met: false, reason: `${parts}; okRate fell` }
  }
  return { met: true, reason: parts }
}

const compareLine = (compare: ContextCostsBody["compare"]): string => {
  if (compare === null) return "none"
  if (compare.kind === "window") {
    return `window ${compare.window?.since ?? ""} .. ${compare.window?.until ?? ""} (n=${compare.totals?.n ?? 0})`
  }
  return `baseline:${compare.project ?? ""} tokens_per_task=${compare.value ?? MISSING} (${compare.windowFrom ?? ""} .. ${compare.windowTo ?? ""})`
}

// Table of the rows, the totals, the delta and the verdict. Plain text, or the body as JSON with --json.
export const renderContextCosts = (
  body: ContextCostsBody,
  json: boolean,
  verdict: GoalVerdict | undefined,
): string => {
  if (json) {
    return JSON.stringify(verdict === undefined ? body : { ...body, goal: verdict }, null, 2)
  }
  const lines = body.rows.map((row) => [
    row.key,
    String(row.n),
    row.tokensInAvg.toFixed(1),
    row.tokensInP90.toFixed(1),
    row.contextTokensAvg === null ? MISSING : String(Math.round(row.contextTokensAvg)),
    `${(row.okRate * 100).toFixed(1)}%`,
  ])
  const header = ["key", "n", "tokensInAvg", "tokensInP90", "ctxAvg", "okRate"]
  const table = body.rows.length === 0 ? ["no executions in the window"] : formatTable([header, ...lines])
  const totals = body.totals
  return [
    `window ${body.window.since} .. ${body.window.until} by ${body.by}`,
    ...table,
    "",
    `totals: n=${totals.n} tokensInAvg=${totals.tokensInAvg === null ? MISSING : totals.tokensInAvg.toFixed(1)} okRate=${totals.okRate === null ? MISSING : `${(totals.okRate * 100).toFixed(1)}%`}`,
    `compare: ${compareLine(body.compare)}`,
    `tokensIn per execution vs compare: ${signed(body.delta.tokensInAvgPct, "%")}`,
    `okRate vs compare: ${signed(body.delta.okRatePct, " pp")}`,
    `unpaired executions (no executor.started in the window): ${body.unpaired}`,
    ...(body.note === null ? [] : [`note: ${body.note}`]),
    ...(verdict === undefined ? [] : [`goal: ${verdict.met ? "MET" : "NOT MET"} (${verdict.reason})`]),
  ].join("\n")
}

// `costs context`: GET /costs/context with the flags. With --goal, the exit code follows the verdict.
export const costsContext = (
  argv: ReadonlyArray<string>,
  settingsFor: (flags: Flags) => Effect.Effect<Settings, UsageError>,
): Effect.Effect<void, UsageError | HttpError | SchemaViolation | GoalNotMet> =>
  Effect.gen(function* () {
    const json = argv.includes("--json")
    const { flags } = yield* parseArgs(
      argv.filter((arg) => arg !== "--json"),
      ["by", "since", "compare", "goal", "url", "token"],
    )
    const goal = yield* parseGoal(flags.goal)
    const query = yield* contextQuery(flags)
    const settings = yield* settingsFor(flags)
    const body = yield* new ApiClient(settings.url, settings.token).get(
      `/costs/context?${query.toString()}`,
      ContextCostsBody,
    )
    const verdict = goal === undefined ? undefined : goalVerdict(body, goal)
    yield* Console.log(renderContextCosts(body, json, verdict))
    if (verdict !== undefined && !verdict.met) {
      return yield* new GoalNotMet({ message: `goal not met: ${verdict.reason}` })
    }
  })
