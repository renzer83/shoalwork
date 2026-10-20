import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape, loadBotEntries } from "@shoalwork/bots"
import {
  type BotId,
  NotFound,
  newTideId,
  SchemaViolation,
  type TaskSpec,
  type Tide,
  type TideId,
  tideShapeIssue,
} from "@shoalwork/contracts"
import { Lead, type LeadShape } from "@shoalwork/lead"
import { Context, Data, Effect, Layer, Option, type Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { fireTide, type SkipReason, type TideDeps } from "./fire.js"
import { decodeTideRows, type TideRow, tideFromRow } from "./row.js"
import { checkSchedule, makeScheduler, nextRunAfter } from "./scheduler.js"
import { startEventTriggers } from "./triggers.js"

// Asked to run a Tide that a pause, the budget, the cooldown or the hourly limit holds back. Also recorded as an event.
export class TideSkipped extends Data.TaggedError("TideSkipped")<{
  readonly tideId: TideId
  readonly reason: SkipReason
}> {}

export interface TidesShape {
  // Stores a Tide by id, or by (bot, name) when no id is given. A cron Tide keeps its schedule when nothing about it changed.
  readonly upsert: (
    t: Omit<Tide, "id"> & { readonly id?: TideId },
  ) => Effect.Effect<Tide, SchemaViolation | NotFound | SqlError>
  readonly list: (botId?: BotId) => Effect.Effect<ReadonlyArray<Tide>, SqlError>
  // Turning a cron Tide on computes its next run from now; turning it off keeps the stored one. One transaction.
  readonly enable: (id: TideId, on: boolean) => Effect.Effect<void, NotFound | SqlError>
  // Fires the Tide now, whether or not it is enabled. A held-back Tide gets TideSkipped.
  readonly runNow: (
    id: TideId,
  ) => Effect.Effect<TaskSpec, NotFound | TideSkipped | SchemaViolation | SqlError>
  readonly startScheduler: (opts: { readonly pollMs: number }) => Effect.Effect<void, never, Scope.Scope>
  // Upserts the tides declared under `tides:` in every bot file of the directory. Run after BotRegistry.syncFromDir.
  readonly syncFromDir: (
    dir: string,
  ) => Effect.Effect<ReadonlyArray<Tide>, SchemaViolation | NotFound | SqlError>
  // One pass of the cron scheduler (what the loop repeats). Exposed so the core and the tests drive it.
  readonly tick: () => Effect.Effect<void>
  // The ids of the cron windows one pass would claim now: claimed rows keep their lock until fired or expired.
  readonly claimDue: () => Effect.Effect<ReadonlyArray<string>, SqlError>
}

export class Tides extends Context.Service<Tides, TidesShape>()("@shoalwork/Tides") {}

export interface TidesOptions {
  // A Bot's budget window (BUDGET_BOT_WINDOW_HOURS in services/core).
  readonly botBudgetWindowMs: number
  // Injected in tests; the real clock otherwise.
  readonly clock?: () => Date
}

// The next run as stored (ISO-8601 UTC), or null when there is none.
const nextIso = (expr: string, timezone: string, from: Date): string | null =>
  Option.getOrNull(Option.map(nextRunAfter(expr, timezone, from), (date) => date.toISOString()))

export const makeTides = (deps: TideDeps): TidesShape => {
  const { sql } = deps
  const scheduler = makeScheduler(deps)

  // The event types of the enabled event tides, held in memory. Refreshed by every change made through this service.
  const refreshEventTypes: Effect.Effect<void, SqlError> = Effect.gen(function* () {
    const rows = yield* sql<{ readonly event_type: string }>`SELECT DISTINCT event_type FROM tides
      WHERE kind = 'event' AND enabled = 1 AND event_type IS NOT NULL`
    deps.eventTypes.clear()
    for (const row of rows) {
      deps.eventTypes.add(row.event_type)
    }
  })

  const findById = (id: TideId): Effect.Effect<TideRow, NotFound | SqlError> =>
    Effect.gen(function* () {
      const rows = yield* decodeTideRows(yield* sql`SELECT * FROM tides WHERE id = ${id}`)
      const [row] = rows
      return row === undefined ? yield* Effect.fail(new NotFound({ entity: "Tide", id })) : row
    })

  // A stored tide that cannot be read is left out and logged; the others are listed.
  const list = (botId?: BotId) =>
    Effect.gen(function* () {
      const rows =
        botId === undefined
          ? yield* sql`SELECT * FROM tides ORDER BY bot_id, name`
          : yield* sql`SELECT * FROM tides WHERE bot_id = ${botId} ORDER BY name`
      const listed: Array<Tide> = []
      for (const row of yield* decodeTideRows(rows)) {
        const tide = yield* tideFromRow(row).pipe(
          Effect.catch((broken) =>
            Effect.logWarning("broken tide left out of the list", broken.reason).pipe(Effect.as(undefined)),
          ),
        )
        if (tide !== undefined) {
          listed.push(tide)
        }
      }
      return listed
    })

  const upsert = (input: Omit<Tide, "id"> & { readonly id?: TideId }) =>
    Effect.gen(function* () {
      const issue = tideShapeIssue(input)
      if (issue !== undefined) {
        return yield* Effect.fail(new SchemaViolation({ where: `tide:${input.name}`, issue }))
      }
      const now = deps.clock()
      if (input.kind === "cron" && input.cronExpr !== undefined) {
        yield* checkSchedule(input.cronExpr, input.timezone, now)
      }
      yield* deps.bots.get(input.botId)
      const stored = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            input.id === undefined
              ? yield* sql`SELECT * FROM tides WHERE bot_id = ${input.botId} AND name = ${input.name}`
              : yield* sql`SELECT * FROM tides WHERE id = ${input.id}`
          const [existing] = yield* decodeTideRows(rows)
          const id: TideId = existing?.id ?? input.id ?? newTideId()
          const cronExpr = input.cronExpr ?? null
          const eventType = input.eventType ?? null
          const eventFilter = input.eventFilter === undefined ? null : JSON.stringify(input.eventFilter)
          const template = JSON.stringify(input.taskTemplate)
          const enabled = input.enabled ? 1 : 0
          // A schedule nobody changed keeps its next run; a new or changed one starts from now.
          const unchanged =
            existing !== undefined &&
            existing.kind === input.kind &&
            existing.cron_expr === cronExpr &&
            existing.timezone === input.timezone &&
            existing.enabled === enabled &&
            existing.next_run_at !== null
          const nextRun =
            input.kind !== "cron" || !input.enabled || input.cronExpr === undefined
              ? null
              : unchanged && existing !== undefined
                ? existing.next_run_at
                : nextIso(input.cronExpr, input.timezone, now)
          // The lock belongs to the window in flight: an upsert that leaves the schedule where it was keeps it.
          const lock = existing !== undefined && existing.next_run_at === nextRun ? existing.locked_at : null
          if (existing === undefined) {
            yield* sql`INSERT INTO tides (id, bot_id, name, kind, cron_expr, timezone, event_type, event_filter,
              task_template, enabled, cooldown_seconds, max_fires_per_hour, next_run_at, last_run_at, locked_at, secret)
              VALUES (${id}, ${input.botId}, ${input.name}, ${input.kind}, ${cronExpr}, ${input.timezone},
                ${eventType}, ${eventFilter}, ${template}, ${enabled}, ${input.cooldownSeconds},
                ${input.maxFiresPerHour}, ${nextRun}, NULL, NULL, NULL)`
          } else {
            yield* sql`UPDATE tides SET bot_id = ${input.botId}, name = ${input.name}, kind = ${input.kind},
              cron_expr = ${cronExpr}, timezone = ${input.timezone}, event_type = ${eventType},
              event_filter = ${eventFilter}, task_template = ${template}, enabled = ${enabled},
              cooldown_seconds = ${input.cooldownSeconds}, max_fires_per_hour = ${input.maxFiresPerHour},
              next_run_at = ${nextRun}, locked_at = ${lock}
              WHERE id = ${id}`
          }
          return { ...input, id }
        }),
      )
      yield* refreshEventTypes
      return stored
    })

  const enable = (id: TideId, on: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* findById(id)
          const next =
            on && row.kind === "cron" && row.cron_expr !== null
              ? nextIso(row.cron_expr, row.timezone, deps.clock())
              : row.next_run_at
          yield* sql`UPDATE tides SET enabled = ${on ? 1 : 0}, next_run_at = ${next}, locked_at = NULL
            WHERE id = ${id}`
        }),
      )
      .pipe(Effect.andThen(refreshEventTypes))

  const runNow = (id: TideId) =>
    Effect.gen(function* () {
      const row = yield* findById(id)
      const tide = yield* tideFromRow(row).pipe(
        Effect.mapError((broken) => new SchemaViolation({ where: `tide:${id}`, issue: broken.reason })),
      )
      const outcome = yield* sql.withTransaction(fireTide(deps, tide))
      if (outcome._tag === "skipped") {
        return yield* Effect.fail(new TideSkipped({ tideId: id, reason: outcome.reason }))
      }
      return outcome.spec
    })

  const syncFromDir = (dir: string) =>
    Effect.gen(function* () {
      const entries = yield* loadBotEntries(dir)
      const synced: Array<Tide> = []
      for (const entry of entries) {
        const bot = yield* deps.bots.getByName(entry.bot.name)
        const current = yield* list(bot.id)
        for (const declared of entry.tides) {
          // The yaml never re-enables a Tide that was switched off through the API.
          const enabled = current.find((tide) => tide.name === declared.name)?.enabled ?? true
          synced.push(yield* upsert({ ...declared, botId: bot.id, enabled }))
        }
      }
      return synced
    })

  return {
    upsert,
    list,
    enable,
    runNow,
    startScheduler: ({ pollMs }) =>
      Effect.gen(function* () {
        yield* refreshEventTypes.pipe(
          Effect.catch((error) => Effect.logWarning("tide event index not loaded", error._tag)),
        )
        yield* Effect.forkScoped(scheduler.loop(pollMs))
        yield* startEventTriggers(deps)
      }),
    syncFromDir,
    tick: () => scheduler.tick,
    claimDue: () => scheduler.claimDue(deps.clock()).pipe(Effect.map((rows) => rows.map((row) => row.id))),
  }
}

export const TidesLive = (
  options: TidesOptions,
): Layer.Layer<Tides, never, SqlClient | Beacon | BotRegistry | Lead> =>
  Layer.effect(
    Tides,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon: BeaconShape = yield* Beacon
      const bots: BotRegistryShape = yield* BotRegistry
      const lead: LeadShape = yield* Lead
      return makeTides({
        sql,
        beacon,
        bots,
        lead,
        clock: options.clock ?? (() => new Date()),
        botBudgetWindowMs: options.botBudgetWindowMs,
        eventTypes: new Set<string>(),
      })
    }),
  )
