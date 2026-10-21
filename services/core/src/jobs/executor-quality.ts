import {
  Beacon,
  type BeaconShape,
  computeExecutorQualityWindows,
  type ExecutorQualityRow,
} from "@shoalwork/beacon"
import type { SystemTideOptions } from "@shoalwork/tides"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// The windows the routing reads (02-architecture §16). One row per (executor, kind, window).
export const EXECUTOR_QUALITY_WINDOWS = [7, 30] as const
// Top of every hour, UTC: the table is at most one hour old.
export const EXECUTOR_QUALITY_CRON = "0 * * * *"
export const EXECUTOR_QUALITY_JOB = "executor-quality"

const DAY_MS = 86_400_000
const LONGEST_WINDOW_MS = Math.max(...EXECUTOR_QUALITY_WINDOWS) * DAY_MS

// Task streams that have a run or a spend inside the longest window. Only these are read, and each one whole: its
// task.received (kind) and its earlier runs (retry) are needed. Tasks idle for the whole window are never read.
const activeStreams = (sql: SqlClient, now: number): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.gen(function* () {
    const cutoff = new Date(now - LONGEST_WINDOW_MS).toISOString()
    const rows = yield* sql<{ readonly stream_id: string }>`SELECT DISTINCT stream_id FROM events
      WHERE type IN ('executor.started', 'executor.finished', 'usage.recorded') AND occurred_at > ${cutoff}`
    return rows.map((row) => row.stream_id)
  })

// Replaces every window in one transaction: a window with no runs left loses its old rows too.
const replaceAll = (sql: SqlClient, rows: ReadonlyArray<ExecutorQualityRow>): Effect.Effect<void, SqlError> =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.forEach(
        EXECUTOR_QUALITY_WINDOWS,
        (days) => sql`DELETE FROM executor_quality WHERE window_days = ${days}`,
        { discard: true },
      )
      yield* Effect.forEach(
        rows,
        (row) =>
          sql`INSERT INTO executor_quality (executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at)
            VALUES (${row.executor}, ${row.kind}, ${row.window_days}, ${row.n}, ${row.ok_rate}, ${row.retry_rate},
              ${row.avg_usd}, ${row.avg_seconds}, ${row.computed_at})`,
        { discard: true },
      )
    }),
  )

// Recomputes every window of executor_quality from the log: one read of the active streams, one decode, one
// transaction. `now` is epoch ms (injected by the caller).
export const refreshExecutorQuality = (now: number): Effect.Effect<void, SqlError, Beacon | SqlClient> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const sql = yield* SqlClient
    const streams = yield* activeStreams(sql, now)
    const logged = yield* Effect.forEach(streams, (streamId) =>
      Stream.runCollect(beacon.readStream(streamId)).pipe(Effect.map((chunk) => Array.from(chunk))),
    )
    const rows = computeExecutorQualityWindows(logged.flat(), now, [...EXECUTOR_QUALITY_WINDOWS])
    yield* replaceAll(sql, rows)
  })

// The hourly job as a system tide (tides/system.ts): one row in system_tides, runs once per window, survives restarts.
// Register it at the composition root with startSystemTide(sql, executorQualityTide(sql, beacon)).
export const executorQualityTide = (sql: SqlClient, beacon: BeaconShape): SystemTideOptions => ({
  name: EXECUTOR_QUALITY_JOB,
  expr: EXECUTOR_QUALITY_CRON,
  run: Effect.suspend(() => refreshExecutorQuality(Date.now())).pipe(
    Effect.provideService(Beacon, beacon),
    Effect.provideService(SqlClient, sql),
  ),
})
