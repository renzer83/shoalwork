import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { ExecutorId, type QuotaStatus, type Usage } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { decodeQuotaConfig, loadQuotaConfig, QuotaConfig, windowsOf } from "../../src/quota/config.js"
import { makeQuotaStore, QuotaStore, QuotaStoreLive, type QuotaStoreShape } from "../../src/quota/store.js"

const claude = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const codex = Schema.decodeUnknownSync(ExecutorId)("codex")

const HOUR_MS = 60 * 60 * 1000
const START_MS = Date.UTC(2026, 9, 21, 12, 0, 0)

// Synthetic test config (not the shipped one): claude-code has 100 tokens per 5h and 1000 per 7d; codex has none.
const config = Schema.decodeUnknownSync(QuotaConfig)({
  executors: {
    "claude-code": {
      windows: [
        { kind: "5h", soft_tokens: 100 },
        { kind: "7d", soft_tokens: 1000 },
      ],
    },
  },
})

const usage = (tokensIn: number, tokensOut: number, usd = 0): Usage => ({
  tokensIn,
  tokensOut,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
  seconds: 0,
})

// End of the soonest window the status reports, in epoch ms (-1 when the status names no window).
const endMs = (status: QuotaStatus): number =>
  status.windowEndsAt === undefined ? -1 : DateTime.toEpochMillis(status.windowEndsAt)

describe("makeQuotaStore windows", () => {
  it.effect("opens a 5h window on first usage and renews it once it has ended", () =>
    Effect.gen(function* () {
      let clock = START_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)

      yield* store.record(claude, usage(30, 30))
      let status = yield* store.status(claude)
      expect(status).toMatchObject({ executor: claude, usedRatio: 0.6, available: true })
      expect(endMs(status)).toBe(START_MS + 5 * HOUR_MS)

      // The 5h window has ended; the 7d window is still open and holds 60 of 1000 tokens.
      clock = START_MS + 5 * HOUR_MS
      status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 0.06, available: true })
      expect(endMs(status)).toBe(START_MS + 7 * 24 * HOUR_MS)

      // New usage opens a fresh 5h window: 10 of 100 tokens there, 70 of 1000 in the 7d window.
      yield* store.record(claude, usage(5, 5))
      status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 0.1, available: true })
      expect(endMs(status)).toBe(START_MS + 10 * HOUR_MS)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("becomes unavailable once the soft limit is reached", () =>
    Effect.gen(function* () {
      const clock = START_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)

      yield* store.record(claude, usage(50, 0))
      expect(yield* store.status(claude)).toMatchObject({ usedRatio: 0.5, available: true })
      yield* store.record(claude, usage(50, 50))
      const status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 1, available: false })
      expect(endMs(status)).toBe(START_MS + 5 * HOUR_MS)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("uses the usd ratio only for windows that set soft_usd", () =>
    Effect.gen(function* () {
      const withUsd = Schema.decodeUnknownSync(QuotaConfig)({
        executors: { "claude-code": { windows: [{ kind: "5h", soft_tokens: 100, soft_usd: 1 }] } },
      })
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, withUsd, () => START_MS)
      yield* store.record(claude, usage(1, 1, 0.5))
      // Tokens alone give 0.02; the usd ratio 0.5 is larger and wins.
      expect(yield* store.status(claude)).toMatchObject({ usedRatio: 0.5, available: true })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("reports an executor without windows as unlimited and ignores its marks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => START_MS)
      yield* store.record(codex, usage(1_000_000, 1_000_000))
      yield* store.markExhausted(codex, "429")
      expect(yield* store.status(codex)).toEqual({ executor: codex, usedRatio: 0, available: true })
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("makeQuotaStore exhaustion", () => {
  it.effect("a limit text exhausts the executor until the shortest window ends, then clears", () =>
    Effect.gen(function* () {
      let clock = START_MS + HOUR_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)

      yield* store.markExhausted(claude, "limit_text")
      let status = yield* store.status(claude)
      expect(status).toMatchObject({ available: false })
      expect(endMs(status)).toBe(START_MS + 6 * HOUR_MS)

      clock = START_MS + 6 * HOUR_MS - 1
      expect(yield* store.status(claude)).toMatchObject({ available: false })

      clock = START_MS + 6 * HOUR_MS
      status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 0, available: true })
      expect(status.windowEndsAt).toBeUndefined()
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("keeps the source of the mark in the database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => START_MS)
      yield* store.markExhausted(claude, "429")
      const rows = yield* sql<{ readonly source: string; readonly exhausted_at: string }>`
        SELECT source, exhausted_at FROM executor_quota WHERE executor = ${claude}`
      expect(rows).toEqual([{ source: "429", exhausted_at: new Date(START_MS).toISOString() }])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a manual until extends the window, and a past instant clears the mark only", () =>
    Effect.gen(function* () {
      let clock = START_MS
      const sql = yield* SqlClient
      const store: QuotaStoreShape = makeQuotaStore(sql, config, () => clock)

      yield* store.record(claude, usage(50, 0))
      yield* store.markExhausted(claude, "limit_text")
      let status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 0.5, available: false })
      expect(endMs(status)).toBe(START_MS + 5 * HOUR_MS)

      // A manual until before the window end never shortens the window.
      yield* store.setExhaustedUntil(claude, DateTime.makeUnsafe(START_MS + 2 * HOUR_MS))
      expect(endMs(yield* store.status(claude))).toBe(START_MS + 5 * HOUR_MS)

      // A later one extends it.
      yield* store.setExhaustedUntil(claude, DateTime.makeUnsafe(START_MS + 8 * HOUR_MS))
      expect(endMs(yield* store.status(claude))).toBe(START_MS + 8 * HOUR_MS)

      // An instant not after now clears the mark; the window stays open and keeps its usage.
      clock = START_MS + HOUR_MS
      yield* store.setExhaustedUntil(claude, DateTime.makeUnsafe(clock))
      status = yield* store.status(claude)
      expect(status).toMatchObject({ usedRatio: 0.5, available: true })
      expect(endMs(status)).toBe(START_MS + 8 * HOUR_MS)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("clearing a mark keeps the window end and the tokens in the database", () =>
    Effect.gen(function* () {
      let clock = START_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)
      yield* store.record(claude, usage(20, 10))
      yield* store.markExhausted(claude, "429")
      clock = START_MS + HOUR_MS
      yield* store.setExhaustedUntil(claude, DateTime.makeUnsafe(clock))
      const rows = yield* sql<{
        readonly window_end: string
        readonly tokens_used: number
        readonly exhausted_at: string | null
      }>`
        SELECT window_end, tokens_used, exhausted_at FROM executor_quota
        WHERE executor = ${claude} AND window_kind = '5h'`
      expect(rows).toEqual([
        { window_end: new Date(START_MS + 5 * HOUR_MS).toISOString(), tokens_used: 30, exhausted_at: null },
      ])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a limit mark never shortens the window it marks", () =>
    Effect.gen(function* () {
      let clock = START_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)
      yield* store.record(claude, usage(1, 1))
      clock = START_MS + 4 * HOUR_MS
      yield* store.markExhausted(claude, "limit_text")
      expect(endMs(yield* store.status(claude))).toBe(START_MS + 5 * HOUR_MS)
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("makeQuotaStore concurrency and rollover", () => {
  it.effect("twenty concurrent records add up exactly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => START_MS)
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        () => store.record(claude, usage(1, 1)),
        { concurrency: "unbounded", discard: true },
      )
      const rows = yield* sql<{ readonly rows: number; readonly tokens: number }>`
        SELECT COUNT(*) AS rows, SUM(tokens_used) AS tokens FROM executor_quota
        WHERE executor = ${claude} AND window_kind = '5h'`
      expect(rows).toEqual([{ rows: 1, tokens: 40 }])
      expect(yield* store.status(claude)).toMatchObject({ usedRatio: 0.4, available: true })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a record and a limit mark on an empty window leave one row with both effects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => START_MS)
      yield* Effect.all([store.record(claude, usage(10, 10)), store.markExhausted(claude, "limit_text")], {
        concurrency: "unbounded",
        discard: true,
      })
      const rows = yield* sql<{ readonly rows: number; readonly tokens: number; readonly marked: number }>`
        SELECT COUNT(*) AS rows, SUM(tokens_used) AS tokens,
          SUM(CASE WHEN exhausted_at IS NOT NULL THEN 1 ELSE 0 END) AS marked
        FROM executor_quota WHERE executor = ${claude} AND window_kind = '5h'`
      expect(rows).toEqual([{ rows: 1, tokens: 20, marked: 1 }])
      expect(yield* store.status(claude)).toMatchObject({ available: false })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("rolls the 7d window over after seven days and counts only the new usage", () =>
    Effect.gen(function* () {
      let clock = START_MS
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, config, () => clock)
      yield* store.record(claude, usage(10, 0))
      clock = START_MS + 7 * 24 * HOUR_MS
      yield* store.record(claude, usage(5, 0))
      const rows = yield* sql<{ readonly window_start: string; readonly tokens_used: number }>`
        SELECT window_start, tokens_used FROM executor_quota
        WHERE executor = ${claude} AND window_kind = '7d' ORDER BY window_start`
      expect(rows).toEqual([
        { window_start: new Date(START_MS).toISOString(), tokens_used: 10 },
        { window_start: new Date(START_MS + 7 * 24 * HOUR_MS).toISOString(), tokens_used: 5 },
      ])
      // The 5h window opened at the same instant holds 5 of 100 tokens; the 7d window is at 5 of 1000.
      expect(yield* store.status(claude)).toMatchObject({ usedRatio: 0.05, available: true })
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("makeQuotaStore persistence", () => {
  it.effect("a new store over the same database reports the same usage and exhaustion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const before = makeQuotaStore(sql, config, () => START_MS)
      yield* before.record(claude, usage(40, 10))
      yield* before.markExhausted(claude, "limit_text")
      const expected = yield* before.status(claude)

      // A second instance has no in-memory state: whatever it reads came from the database.
      const after = makeQuotaStore(sql, config, () => START_MS + HOUR_MS)
      expect(yield* after.status(claude)).toEqual(expected)
      expect(expected).toMatchObject({ usedRatio: 0.5, available: false })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("QuotaStoreLive provides the store as a service over the database", () =>
    Effect.gen(function* () {
      const store = yield* QuotaStore
      yield* store.record(claude, usage(25, 0))
      expect(yield* store.status(claude)).toMatchObject({ usedRatio: 0.25, available: true })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          QuotaStoreLive(config, () => START_MS),
          withTempDb(),
        ),
      ),
    ),
  )
})

describe("quota config", () => {
  it.effect("loads the shipped config/quotas.yaml with the claude-code and codex windows", () =>
    Effect.gen(function* () {
      const path = fileURLToPath(new URL("../../../../config/quotas.yaml", import.meta.url))
      const loaded = yield* loadQuotaConfig(path)
      expect(windowsOf(loaded, claude).map((window) => window.kind)).toEqual(["5h", "7d"])
      expect(windowsOf(loaded, codex).map((window) => window.kind)).toEqual(["5h", "7d"])
    }),
  )

  it.effect("rejects a window kind other than 5h or 7d", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeQuotaConfig(
          { executors: { codex: { windows: [{ kind: "1h", soft_tokens: 10 }] } } },
          "test/quotas.yaml",
        ),
      )
      expect(error._tag).toBe("ConfigError")
      expect(error.key).toBe("test/quotas.yaml")
    }),
  )
})
