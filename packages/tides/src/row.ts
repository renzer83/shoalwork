import { BotId, Tide, TideId } from "@shoalwork/contracts"
import { Data, Effect, Schema } from "effect"

// Columns of the tides table (snake_case). Decoded at the database boundary.
export const TideRow = Schema.Struct({
  id: TideId,
  bot_id: BotId,
  name: Schema.String,
  kind: Schema.String,
  cron_expr: Schema.NullOr(Schema.String),
  timezone: Schema.String,
  event_type: Schema.NullOr(Schema.String),
  event_filter: Schema.NullOr(Schema.String),
  task_template: Schema.String,
  enabled: Schema.Int,
  cooldown_seconds: Schema.Int,
  max_fires_per_hour: Schema.Int,
  next_run_at: Schema.NullOr(Schema.String),
  last_run_at: Schema.NullOr(Schema.String),
  locked_at: Schema.NullOr(Schema.String),
  secret: Schema.NullOr(Schema.String),
})
export type TideRow = typeof TideRow.Type

// One stored tide that cannot be read back. It is disabled alone; the other tides keep running.
export class BrokenTide extends Data.TaggedError("BrokenTide")<{
  readonly id: TideId
  readonly botId: BotId
  readonly reason: string
}> {}

// Rows come from this package's own statements: a mismatch in the typed columns is a bug, so it is a defect.
export const decodeTideRows = (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<TideRow>> =>
  Schema.decodeUnknownEffect(Schema.Array(TideRow))(rows).pipe(Effect.orDie)

// The stored JSON columns are trusted only after the Tide schema decodes them. A failure is a BrokenTide, not a defect.
export const tideFromRow = (row: TideRow): Effect.Effect<Tide, BrokenTide> =>
  Effect.gen(function* () {
    const broken = (reason: string) => new BrokenTide({ id: row.id, botId: row.bot_id, reason })
    const templateText = row.task_template
    const template = yield* Effect.try({
      try: (): unknown => JSON.parse(templateText),
      catch: () => broken("task_template is not JSON"),
    })
    const filterText = row.event_filter
    const filter =
      filterText === null
        ? undefined
        : yield* Effect.try({
            try: (): unknown => JSON.parse(filterText),
            catch: () => broken("event_filter is not JSON"),
          })
    return yield* Schema.decodeUnknownEffect(Tide)({
      id: row.id,
      botId: row.bot_id,
      name: row.name,
      kind: row.kind,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      cooldownSeconds: row.cooldown_seconds,
      maxFiresPerHour: row.max_fires_per_hour,
      taskTemplate: template,
      ...(row.cron_expr === null ? {} : { cronExpr: row.cron_expr }),
      ...(row.event_type === null ? {} : { eventType: row.event_type }),
      ...(filter === undefined ? {} : { eventFilter: filter }),
    }).pipe(Effect.mapError(() => broken("stored tide does not match the Tide schema")))
  })
