import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { sqlSummaryCache, summaryKey } from "../../src/context/compact-cache.js"
import {
  DEFAULT_COMPACTION,
  DEFAULT_CONTEXT_CONFIG,
  decodeContextConfigText,
} from "../../src/context/config.js"

// The summary cache over context_summaries (T-097) and the compaction config's defaults.
describe("compaction cache and config (T-097)", () => {
  it.effect("the SQL cache reads a batch until its TTL, and a write deletes the rows past it", () =>
    Effect.gen(function* () {
      let clock = Date.parse("2026-10-21T00:00:00.000Z")
      const cache = yield* sqlSummaryCache(2, () => clock)
      const a = summaryKey("s", 2, "alpha")
      const b = summaryKey("s", 3, "beta")
      const c = summaryKey("s", 2, "gamma")
      const d = summaryKey("s", 2, "delta")
      yield* cache.putMany([
        { key: a, level: 2, summary: "short a", tokens: 2 },
        { key: d, level: 2, summary: "short d", tokens: 2 },
      ])
      clock += 60 * 60 * 1000
      expect(yield* cache.getMany([a, b])).toEqual(new Map([[a, "short a"]]))
      yield* cache.putMany([{ key: b, level: 3, summary: "short b", tokens: 2 }])
      clock += 3 * 60 * 60 * 1000
      yield* cache.putMany([{ key: c, level: 2, summary: "short c", tokens: 2 }])
      const sql = yield* SqlClient
      const rows = yield* sql<{ readonly hash: string }>`SELECT hash FROM context_summaries`
      expect(rows.map((row) => row.hash)).toEqual([c])
      expect(yield* cache.getMany([a, b, c])).toEqual(new Map([[c, "short c"]]))
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect(
    "a config without a compaction section gets the defaults; a level outside 1 to 3 is rejected",
    () =>
      Effect.gen(function* () {
        const without = Object.fromEntries(
          Object.entries(DEFAULT_CONTEXT_CONFIG).filter(([key]) => key !== "compaction"),
        )
        const decoded = yield* decodeContextConfigText(JSON.stringify(without), "ctx.yaml")
        expect(decoded.compaction).toEqual(DEFAULT_COMPACTION)
        const bad = yield* Effect.flip(
          decodeContextConfigText(
            JSON.stringify({ ...DEFAULT_CONTEXT_CONFIG, compaction: { ...DEFAULT_COMPACTION, levels: 4 } }),
            "ctx.yaml",
          ),
        )
        expect(bad._tag).toBe("ConfigError")
      }),
  )
})
