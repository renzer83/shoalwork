import { SchemaViolation } from "@shoalwork/contracts"
import { Cron } from "croner"
import { Cause, Duration, Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { fireTide, handleTideFailure, ScheduleBroken, type TideDeps } from "./fire.js"
import { BrokenTide, decodeTideRows, type TideRow, tideFromRow } from "./row.js"

// A claim older than this belongs to a scheduler that died mid-fire; another one may take the window.
export const LOCK_WINDOW_MS = 5 * 60_000

// Next run strictly after `from`, or none when the expression or the timezone is rejected or never matches again.
// The Cron is built paused: nothing is scheduled, only the calculation is used.
const tryNext = Option.liftThrowable((expr: string, timezone: string, from: Date): Date | null =>
  new Cron(expr, { timezone, paused: true }).nextRun(from),
)

export const nextRunAfter = (expr: string, timezone: string, from: Date): Option.Option<Date> =>
  Option.flatMap(tryNext(expr, timezone, from), Option.fromNullishOr)

// Checked when a cron Tide is stored: a schedule that cannot run is refused, not stored and disabled later.
export const checkSchedule = (
  expr: string,
  timezone: string,
  now: Date,
): Effect.Effect<void, SchemaViolation> =>
  Option.isSome(nextRunAfter(expr, timezone, now))
    ? Effect.void
    : Effect.fail(
        new SchemaViolation({ where: `cronExpr:${expr}`, issue: "expression or timezone not runnable" }),
      )

export const makeScheduler = (deps: TideDeps) => {
  // One write transaction (BEGIN IMMEDIATE): the due cron tides are locked to this scheduler before any of them fires.
  // Two schedulers on one database claim disjoint sets, and a fired window moves next_run_at past now.
  const claimDue = (now: Date): Effect.Effect<ReadonlyArray<TideRow>, SqlError> =>
    Effect.gen(function* () {
      const nowIso = now.toISOString()
      const staleIso = new Date(now.getTime() - LOCK_WINDOW_MS).toISOString()
      const rows = yield* deps.sql.withTransaction(
        deps.sql`UPDATE tides SET locked_at = ${nowIso}
          WHERE id IN (SELECT id FROM tides
            WHERE kind = 'cron' AND enabled = 1 AND next_run_at <= ${nowIso}
              AND (locked_at IS NULL OR locked_at < ${staleIso}))
          RETURNING *`,
      )
      return yield* decodeTideRows(rows)
    })

  // One window of one tide. Each tide is isolated: a broken one is disabled alone and the others still fire.
  // The window is fired and its next run stored in one transaction: a crash never leaves a fired window unrecorded.
  const fireWindow = (row: TideRow) =>
    Effect.gen(function* () {
      const tide = yield* tideFromRow(row)
      if (tide.kind !== "cron" || tide.cronExpr === undefined) {
        return yield* Effect.fail(
          new BrokenTide({ id: row.id, botId: row.bot_id, reason: "cron tide without cronExpr" }),
        )
      }
      const next = nextRunAfter(tide.cronExpr, tide.timezone, deps.clock())
      if (Option.isNone(next)) {
        return yield* Effect.fail(new ScheduleBroken({ tideId: tide.id, expr: tide.cronExpr }))
      }
      yield* deps.sql.withTransaction(
        Effect.gen(function* () {
          yield* fireTide(deps, tide)
          yield* deps.sql`UPDATE tides SET next_run_at = ${next.value.toISOString()}, locked_at = NULL
            WHERE id = ${tide.id}`
        }),
      )
    }).pipe(
      Effect.catch((error) => handleTideFailure(deps, { id: row.id, botId: row.bot_id }, error)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : handleTideFailure(
              deps,
              { id: row.id, botId: row.bot_id },
              new BrokenTide({ id: row.id, botId: row.bot_id, reason: "unexpected failure" }),
            ),
      ),
    )

  const tick = Effect.gen(function* () {
    const due = yield* claimDue(deps.clock())
    yield* Effect.forEach(due, fireWindow, { discard: true })
  }).pipe(
    Effect.catch((error) => Effect.logWarning("tide scheduler claim failed", error._tag)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("tide scheduler tick failed"),
    ),
  )

  const loop = (pollMs: number): Effect.Effect<void> =>
    Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(Duration.millis(pollMs)))))

  return { tick, loop, claimDue }
}
