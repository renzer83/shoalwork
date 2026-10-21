import { it } from "@effect/vitest"
import { Beacon, BeaconLive, type BeaconShape } from "@shoalwork/beacon"
import { BotId, type NewEvent, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  EXECUTOR_QUALITY_CRON,
  EXECUTOR_QUALITY_JOB,
  EXECUTOR_QUALITY_WINDOWS,
  executorQualityTide,
  refreshExecutorQuality,
} from "../src/jobs/executor-quality.js"

const sequence = (n: number, prefix: string) =>
  `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const TASK = Schema.decodeUnknownSync(TaskId)(sequence(1, "task"))
const BOT = Schema.decodeUnknownSync(BotId)(sequence(1, "bot"))

// One code task run by claude-code: ok, cost 0.2, 8 s. Written now, so every window sees it.
const RUN: ReadonlyArray<NewEvent> = [
  {
    streamId: streamIds.task(TASK),
    type: "task.received",
    payload: {
      task: {
        id: TASK,
        botId: BOT,
        title: "t",
        prompt: "p",
        kind: "code",
        acceptance: [],
        budget: { tokens: 1, seconds: 1, usd: 1 },
        tier: "heavy",
        origin: "cli",
      },
    },
    actor: "system:test",
    correlationId: "corr_executor_quality_job",
  },
  {
    streamId: streamIds.task(TASK),
    type: "executor.started",
    payload: { taskId: TASK, botId: BOT, executor: "claude-code", model: "m", cwd: "/tmp" },
    actor: "system:test",
    correlationId: "corr_executor_quality_job",
  },
  {
    streamId: streamIds.task(TASK),
    type: "usage.recorded",
    payload: {
      taskId: TASK,
      botId: BOT,
      executor: "claude-code",
      model: "m",
      usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, usd: 0.2, seconds: 8 },
    },
    actor: "system:test",
    correlationId: "corr_executor_quality_job",
  },
  {
    streamId: streamIds.task(TASK),
    type: "executor.finished",
    payload: {
      taskId: TASK,
      botId: BOT,
      verdict: {
        kind: "ok",
        summary: "s",
        evidence: [],
        cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
      },
      durationMs: 8_000,
    },
    actor: "system:test",
    correlationId: "corr_executor_quality_job",
  },
]

const DAY_MS = 86_400_000

const base = Layer.provideMerge(BeaconLive, withTempDb())

const tableRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{
    readonly executor: string
    readonly kind: string
    readonly window_days: number
    readonly n: number
    readonly avg_usd: number
  }>`SELECT executor, kind, window_days, n, avg_usd FROM executor_quality ORDER BY window_days, executor, kind`
})

describe("executor quality job", () => {
  it.effect("writes one row per (executor, kind) for each window and drops the rows that are stale", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      yield* beacon.appendMany(RUN)
      yield* sql`INSERT INTO executor_quality (executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at)
        VALUES ('ghost', 'code', 7, 9, 1, 0, 0, 1, '2026-10-01T00:00:00.000Z')`

      yield* refreshExecutorQuality(Date.now() + 1_000)

      const rows = yield* tableRows
      expect(rows).toEqual(
        EXECUTOR_QUALITY_WINDOWS.map((days) => ({
          executor: "claude-code",
          kind: "code",
          window_days: days,
          n: 1,
          avg_usd: 0.2,
        })),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("reads no stream of a task idle for the whole longest window", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany(RUN)
      const reads: Array<string> = []
      const spy: BeaconShape = {
        ...beacon,
        readStream: (streamId, afterVersion) => {
          reads.push(streamId)
          return beacon.readStream(streamId, afterVersion)
        },
      }
      // Forty days on, nothing ran in the last thirty: the events are outside the window and never read.
      yield* refreshExecutorQuality(Date.now() + 40 * DAY_MS).pipe(Effect.provideService(Beacon, spy))
      expect(reads).toEqual([])
      expect(yield* tableRows).toEqual([])
    }).pipe(Effect.provide(base)),
  )

  it.effect("the hourly tide carries its name, its cron and runs the same refresh", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      yield* beacon.appendMany(RUN)
      const tide = executorQualityTide(sql, beacon)
      expect(tide.name).toBe(EXECUTOR_QUALITY_JOB)
      expect(tide.expr).toBe(EXECUTOR_QUALITY_CRON)
      yield* tide.run
      expect(yield* tableRows).toHaveLength(EXECUTOR_QUALITY_WINDOWS.length)
    }).pipe(Effect.provide(base)),
  )
})
