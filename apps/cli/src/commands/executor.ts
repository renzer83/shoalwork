import { QuotaStatus, type QuotaStatus as QuotaStatusType, type SchemaViolation } from "@shoalwork/contracts"
import { Console, DateTime, Effect, Schema } from "effect"
import { parseArgs, resolveSettings, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// Mirrors the body of GET /executors/quota (services/core/src/http/routes/executors.ts).
const QuotaList = Schema.Struct({ quotas: Schema.Array(QuotaStatus) })

// The value of --exhausted-until: the word `clear` (sent as null), or an ISO instant that names its zone and lies in
// the future. Anything else is refused, so a typo can never clear a mark.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const EXHAUSTED_UNTIL_USAGE =
  "--exhausted-until expects clear, or an ISO instant with its zone in the future (e.g. 2026-10-21T15:00:00Z)"

export const exhaustedUntilBody = (
  raw: string,
  now: number = Date.now(),
): Effect.Effect<{ readonly exhaustedUntil: string | null }, UsageError> =>
  Effect.gen(function* () {
    if (raw === "clear") {
      return { exhaustedUntil: null }
    }
    const invalid = new UsageError({ message: EXHAUSTED_UNTIL_USAGE })
    if (!ISO_WITH_ZONE.test(raw)) {
      return yield* Effect.fail(invalid)
    }
    const until = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(raw).pipe(
      Effect.mapError(() => invalid),
    )
    if (DateTime.toEpochMillis(until) <= now) {
      return yield* Effect.fail(invalid)
    }
    return { exhaustedUntil: DateTime.formatIso(until) }
  })

// Table of the quota of every executor. Figures are the store's: usedRatio, available, and when the window renews.
export const renderQuota = (quotas: ReadonlyArray<QuotaStatusType>): ReadonlyArray<string> => {
  const header = ["executor", "usedRatio", "available", "windowEndsAt"]
  const rows = quotas.map((quota) => [
    quota.executor,
    quota.usedRatio.toFixed(2),
    quota.available ? "yes" : "no",
    quota.windowEndsAt === undefined ? "-" : DateTime.formatIso(quota.windowEndsAt),
  ])
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

// GET /executors/quota, decoded at the boundary.
export const quotaList = (
  settings: Settings,
): Effect.Effect<ReadonlyArray<QuotaStatusType>, HttpError | SchemaViolation> =>
  new ApiClient(settings.url, settings.token)
    .get("/executors/quota", QuotaList)
    .pipe(Effect.map((body) => body.quotas))

// POST /executors/:id/quota: the resulting status of that executor.
export const quotaSet = (
  settings: Settings,
  id: string,
  body: { readonly exhaustedUntil: string | null },
): Effect.Effect<QuotaStatusType, HttpError | SchemaViolation> =>
  new ApiClient(settings.url, settings.token).post(
    `/executors/${encodeURIComponent(id)}/quota`,
    body,
    QuotaStatus,
  )

export const printQuota = (settings: Settings): Effect.Effect<void, HttpError | SchemaViolation> =>
  Effect.gen(function* () {
    const quotas = yield* quotaList(settings)
    for (const line of renderQuota(quotas)) {
      yield* Console.log(line)
    }
  })

const SETTINGS_FLAGS = ["url", "token"]
const SET_USAGE = "usage: executor quota set <executor id> --exhausted-until <iso|clear>"

// executor quota set <id> --exhausted-until <iso|clear>. The API only extends a window or clears the mark.
const setQuotaCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { flags, positionals } = yield* parseArgs(argv, ["exhausted-until", ...SETTINGS_FLAGS])
    const [id, ...extra] = positionals
    const until = flags["exhausted-until"]
    if (id === undefined || extra.length > 0 || until === undefined) {
      return yield* Effect.fail(new UsageError({ message: SET_USAGE }))
    }
    const settings = yield* resolveSettings(flags, process.env)
    const body = yield* exhaustedUntilBody(until)
    const status = yield* quotaSet(settings, id, body)
    yield* Console.log(JSON.stringify(status, null, 2))
  })

// executor quota: the table of every executor.
const quotaCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { flags, positionals } = yield* parseArgs(argv, SETTINGS_FLAGS)
    if (positionals.length > 0) {
      return yield* Effect.fail(new UsageError({ message: "usage: executor quota" }))
    }
    const settings = yield* resolveSettings(flags, process.env)
    yield* printQuota(settings)
  })

// Dispatch of the executor command: `executor quota` and `executor quota set <id> --exhausted-until <iso|clear>`.
export const executorCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, UsageError | HttpError | SchemaViolation> => {
  const [sub, ...rest] = argv
  if (sub !== "quota") {
    return Effect.fail(
      new UsageError({
        message:
          sub === undefined ? "missing executor subcommand (quota)" : `unknown executor subcommand: ${sub}`,
      }),
    )
  }
  const [action, ...tail] = rest
  return action === "set" ? setQuotaCommand(tail) : quotaCommand(rest)
}
