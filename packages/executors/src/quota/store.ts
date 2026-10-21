import type { ExecutorId, QuotaStatus, Usage } from "@shoalwork/contracts"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type QuotaConfig, type QuotaWindow, WINDOW_MS, type WindowKind, windowsOf } from "./config.js"

// Where an exhaustion mark came from: a 429 status, or a limit text in the CLI's output (signals.ts).
export type ExhaustedSource = "429" | "limit_text"

export type QuotaStoreShape = {
  // Adds one run's usage to every window of the executor that is open now. A window opens on demand.
  readonly record: (executor: ExecutorId, usage: Usage) => Effect.Effect<void, SqlError>
  // The executor reported its limit: the shortest window is exhausted until that window ends.
  readonly markExhausted: (executor: ExecutorId, source: ExhaustedSource) => Effect.Effect<void, SqlError>
  // Set by hand (CLI): exhausted until `until` on the shortest window. An instant not after now clears the mark.
  readonly setExhaustedUntil: (executor: ExecutorId, until: DateTime.Utc) => Effect.Effect<void, SqlError>
  readonly status: (executor: ExecutorId) => Effect.Effect<QuotaStatus, SqlError>
  // Whether quotas.yaml names a window for the executor. Without one, a mark or a clear has nothing to act on.
  readonly hasWindow: (executor: ExecutorId) => boolean
}

export class QuotaStore extends Context.Service<QuotaStore, QuotaStoreShape>()("@shoalwork/QuotaStore") {}

// One open window row as read back from executor_quota. Dates are ISO-8601 UTC TEXT, so string order is time order.
const OpenRow = Schema.Struct({
  window_start: Schema.String,
  window_end: Schema.String,
  tokens_used: Schema.Number,
  usd_used: Schema.Number,
  exhausted_at: Schema.NullOr(Schema.String),
})
type OpenRow = typeof OpenRow.Type

const iso = (ms: number): string => new Date(ms).toISOString()

const shortestWindow = (windows: ReadonlyArray<QuotaWindow>): QuotaWindow | undefined =>
  [...windows].sort((a, b) => WINDOW_MS[a.kind] - WINDOW_MS[b.kind])[0]

// Share of the window's soft limit already used: the larger of the token and the usd ratios (usd only when set).
const ratioOf = (row: OpenRow, window: QuotaWindow): number => {
  const byTokens = row.tokens_used / window.soft_tokens
  return window.soft_usd === undefined ? byTokens : Math.max(byTokens, row.usd_used / window.soft_usd)
}

// All state lives in executor_quota, so a new store over the same database reports the same status (restart-safe).
// `now` (epoch ms) is injected so tests run on a fake clock.
export const makeQuotaStore = (
  sql: SqlClient,
  config: QuotaConfig,
  now: () => number = Date.now,
): QuotaStoreShape => {
  const openWindow = (
    executor: ExecutorId,
    kind: WindowKind,
    at: number,
  ): Effect.Effect<OpenRow | undefined, SqlError> =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT window_start, window_end, tokens_used, usd_used, exhausted_at FROM executor_quota
        WHERE executor = ${executor} AND window_kind = ${kind} AND window_end > ${iso(at)}
        ORDER BY window_start DESC LIMIT 1`
      // A malformed row in our own table is a bug, not an expected failure.
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(OpenRow))(rows).pipe(Effect.orDie)
      return decoded[0]
    })

  // Inserts the window row, or replaces its end and exhaustion mark when the window is already there.
  const putWindow = (
    executor: ExecutorId,
    kind: WindowKind,
    start: string,
    end: string,
    exhaustedAt: string | null,
    source: string,
  ): Effect.Effect<void, SqlError> =>
    sql`
      INSERT INTO executor_quota (executor, window_kind, window_start, window_end, tokens_used, usd_used, exhausted_at, source)
      VALUES (${executor}, ${kind}, ${start}, ${end}, 0, 0, ${exhaustedAt}, ${source})
      ON CONFLICT (executor, window_kind, window_start) DO UPDATE SET
        window_end = excluded.window_end, exhausted_at = excluded.exhausted_at, source = excluded.source`.pipe(
      Effect.asVoid,
    )

  const recordWindow = (executor: ExecutorId, window: QuotaWindow, usage: Usage, at: number) =>
    Effect.gen(function* () {
      const open = yield* openWindow(executor, window.kind, at)
      const start = open?.window_start ?? iso(at)
      const end = open?.window_end ?? iso(at + WINDOW_MS[window.kind])
      yield* sql`
        INSERT INTO executor_quota (executor, window_kind, window_start, window_end, tokens_used, usd_used, source)
        VALUES (${executor}, ${window.kind}, ${start}, ${end}, ${usage.tokensIn + usage.tokensOut}, ${usage.usd}, 'usage')
        ON CONFLICT (executor, window_kind, window_start) DO UPDATE SET
          tokens_used = executor_quota.tokens_used + excluded.tokens_used,
          usd_used = executor_quota.usd_used + excluded.usd_used`
    })

  // Shared by the two marks. With no executor window configured there is nothing to mark: logged, not silent.
  const markShortest = (
    executor: ExecutorId,
    what: string,
    mark: (window: QuotaWindow, at: number, open: OpenRow | undefined) => Effect.Effect<void, SqlError>,
  ): Effect.Effect<void, SqlError> => {
    const window = shortestWindow(windowsOf(config, executor))
    if (window === undefined) {
      return Effect.logWarning(`${what}: executor has no quota window configured`, executor)
    }
    // Read and write in one transaction: a concurrent record or mark cannot slip in between them.
    return sql.withTransaction(
      Effect.gen(function* () {
        const at = now()
        yield* mark(window, at, yield* openWindow(executor, window.kind, at))
      }),
    )
  }

  return {
    hasWindow: (executor) => windowsOf(config, executor).length > 0,
    record: (executor, usage) => {
      const windows = windowsOf(config, executor)
      if (windows.length === 0) return Effect.void
      return sql.withTransaction(
        Effect.forEach(windows, (window) => recordWindow(executor, window, usage, now())).pipe(Effect.asVoid),
      )
    },

    // A mark never shortens a window: the end is kept, or extended to `until`. Usage in the window is never touched.
    markExhausted: (executor, source) =>
      markShortest(executor, "limit reported", (window, at, open) =>
        putWindow(
          executor,
          window.kind,
          open?.window_start ?? iso(at),
          open?.window_end ?? iso(at + WINDOW_MS[window.kind]),
          iso(at),
          source,
        ),
      ),

    setExhaustedUntil: (executor, until) =>
      markShortest(executor, "manual limit", (window, at, open) => {
        const untilMs = DateTime.toEpochMillis(until)
        if (untilMs > at) {
          const endMs = open === undefined ? untilMs : Math.max(Date.parse(open.window_end), untilMs)
          return putWindow(
            executor,
            window.kind,
            open?.window_start ?? iso(at),
            iso(endMs),
            iso(at),
            "manual",
          )
        }
        // Clearing drops only the exhaustion mark: the open window keeps its end and its usage.
        if (open === undefined) return Effect.void
        return putWindow(executor, window.kind, open.window_start, open.window_end, null, "manual")
      }),

    status: (executor) =>
      Effect.gen(function* () {
        const at = now()
        const observed: Array<{
          readonly ratio: number
          readonly exhausted: boolean
          readonly endMs: number
        }> = []
        for (const window of windowsOf(config, executor)) {
          const open = yield* openWindow(executor, window.kind, at)
          if (open !== undefined) {
            observed.push({
              ratio: ratioOf(open, window),
              exhausted: open.exhausted_at !== null,
              endMs: Date.parse(open.window_end),
            })
          }
        }
        const usedRatio = Math.min(
          1,
          observed.reduce((max, window) => Math.max(max, window.ratio), 0),
        )
        // A window blocks when it is marked exhausted or its soft limit is reached. The executor is back when the
        // last blocking window ends; with nothing blocking, the next window to renew is reported.
        const blocking = observed.filter((window) => window.exhausted || window.ratio >= 1)
        const available = blocking.length === 0
        const ends = (available ? observed : blocking).map((window) => window.endMs)
        const windowEnd = available
          ? ends.reduce<number | undefined>(
              (min, end) => (min === undefined || end < min ? end : min),
              undefined,
            )
          : ends.reduce<number | undefined>(
              (max, end) => (max === undefined || end > max ? end : max),
              undefined,
            )
        return {
          executor,
          usedRatio,
          available,
          ...(windowEnd === undefined ? {} : { windowEndsAt: DateTime.makeUnsafe(windowEnd) }),
        }
      }),
  }
}

// Live store over the database of the composition root (the root provides SqlClient).
export const QuotaStoreLive = (
  config: QuotaConfig,
  now: () => number = Date.now,
): Layer.Layer<QuotaStore, never, SqlClient> =>
  Layer.effect(
    QuotaStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      return makeQuotaStore(sql, config, now)
    }),
  )

// Quota of one adapter. Without a store the executor reports unlimited (the adapter runs with no quota injected). A
// store that cannot be read is logged and the executor reported available: a bookkeeping fault must not stop runs.
export const quotaStatusOf = (
  store: QuotaStoreShape | undefined,
  executor: ExecutorId,
): Effect.Effect<QuotaStatus> => {
  const unlimited: QuotaStatus = { executor, usedRatio: 0, available: true }
  if (store === undefined) return Effect.succeed(unlimited)
  return store
    .status(executor)
    .pipe(
      Effect.catch((error) =>
        Effect.logError("quota status unreadable; executor reported as available", error).pipe(
          Effect.as(unlimited),
        ),
      ),
    )
}
