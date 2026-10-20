import type { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

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
