import { Cause, Duration, Effect, Option, type Scope } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { LOCK_WINDOW_MS, nextRunAfter } from "./scheduler.js"

// A cron job of the system itself (not of a Bot): one row in system_tides keeps its next window, so a restart neither
// loses nor repeats a window, and two schedulers on one database never run the same window twice.
export interface SystemTideOptions {
  readonly name: string
  // Cron expression, e.g. "0 4 * * 0" for Sundays at 04:00.
  readonly expr: string
  readonly timezone?: string | undefined
  // What the window does. A failure is logged and the window is spent; the next one runs as scheduled.
  readonly run: Effect.Effect<unknown, unknown>
  readonly clock?: (() => Date) | undefined
}

export const makeSystemTide = (sql: SqlClient, options: SystemTideOptions) => {
  const timezone = options.timezone ?? "UTC"
  const clock = options.clock ?? (() => new Date())
  // Checked once, when the job is made: an expression or timezone croner rejects never gets a window.
  const runnable = Option.isSome(nextRunAfter(options.expr, timezone, clock()))

  const tick: Effect.Effect<void> = Effect.gen(function* () {
    if (!runnable) return
    const now = clock()
    const first = nextRunAfter(options.expr, timezone, now)
    if (Option.isNone(first)) return
    yield* sql`INSERT OR IGNORE INTO system_tides (name, next_run_at) VALUES (${options.name}, ${first.value.toISOString()})`
    const nowIso = now.toISOString()
    const staleIso = new Date(now.getTime() - LOCK_WINDOW_MS).toISOString()
    const claimed = yield* sql`UPDATE system_tides SET locked_at = ${nowIso}
      WHERE name = ${options.name} AND next_run_at <= ${nowIso} AND (locked_at IS NULL OR locked_at < ${staleIso})
      RETURNING name`
    if (claimed.length === 0) return
    yield* options.run.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError(`system tide ${options.name} failed`, Cause.pretty(cause)),
      ),
    )
    const next = nextRunAfter(options.expr, timezone, clock())
    if (Option.isSome(next)) {
      // Only the claim this tick took is released: a window taken over meanwhile belongs to the other scheduler.
      yield* sql`UPDATE system_tides SET next_run_at = ${next.value.toISOString()}, locked_at = NULL
        WHERE name = ${options.name} AND locked_at = ${nowIso}`
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError(`system tide ${options.name}: tick failed`, Cause.pretty(cause)),
    ),
  )

  return { tick, runnable }
}

// Polls the job's window in the background until the scope closes.
export const startSystemTide = (
  sql: SqlClient,
  options: SystemTideOptions & { readonly pollMs?: number | undefined },
): Effect.Effect<void, never, Scope.Scope> => {
  const { tick, runnable } = makeSystemTide(sql, options)
  if (!runnable) {
    return Effect.logWarning(`system tide ${options.name} not started: schedule cannot run`, options.expr)
  }
  return Effect.forkScoped(
    Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(Duration.millis(options.pollMs ?? 60_000))))),
  ).pipe(Effect.asVoid)
}
