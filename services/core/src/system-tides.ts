import { Beacon } from "@shoalwork/beacon"
import { Ranker, runRankTune } from "@shoalwork/reef"
import { startSystemTide } from "@shoalwork/tides"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { executorQualityTide } from "./jobs/executor-quality.js"

// Sundays at 04:00 UTC.
export const RANK_TUNE_CRON = "0 4 * * 0"

// The weekly rank-tune (T-096) as a system tide: tunes the ranking weights on the last briefings and records
// context.weights_updated. The config weights (or the stored ones) are where the tuning starts from.
export const startRankTuneTide = (options: { readonly pollMs: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const ranker = yield* Ranker
    const context = yield* Effect.context<SqlClient | Beacon>()
    yield* startSystemTide(sql, {
      name: "rank-tune",
      expr: RANK_TUNE_CRON,
      pollMs: options.pollMs,
      run: Effect.flatMap(ranker.weights(), (weights) => runRankTune(weights)).pipe(Effect.provide(context)),
    })
  })

// The hourly executor-quality job (T-074) as a system tide: the routing of the executors reads its table.
export const startExecutorQualityTide = (options: { readonly pollMs: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    yield* startSystemTide(sql, { ...executorQualityTide(sql, beacon), pollMs: options.pollMs })
  })
