import { createHash, randomUUID } from "node:crypto"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import {
  Bot,
  BotId,
  type BotState,
  BotState as BotStateSchema,
  type Conflict,
  type NewBot,
  type NewEvent,
  NotFound,
  type SchemaViolation,
  SENSITIVE_BOT_FIELDS,
  streamIds,
  type TaskId,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { loadBotEntries } from "./loader.js"

const BotRow = Schema.Struct({
  id: BotId,
  name: Schema.String,
  definition: Schema.String,
  state: BotStateSchema,
  source_path: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
})
type BotRow = typeof BotRow.Type

const StateRow = Schema.Struct({ state: BotStateSchema })

// Rows are written by this package only: a mismatch is a bug, so it dies instead of becoming a typed error.
const decodeBotRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(BotRow))(rows).pipe(Effect.orDie)

const decodeStateRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(StateRow))(rows).pipe(Effect.orDie)

// The stored definition is the full Bot as JSON (id included). Stored data is trusted only after decoding.
const decodeStoredBot = (row: BotRow): Effect.Effect<Bot> =>
  Effect.try({ try: (): unknown => JSON.parse(row.definition), catch: (cause) => cause }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(Bot)(raw)),
    Effect.orDie,
  )

// Same name, same id on a fresh database. Shaped like a UUID (version 5 / RFC 4122 variant bits) from a SHA-256.
const botIdFor = (name: string): BotId => {
  const hex = createHash("sha256").update(`bot:${name}`).digest("hex")
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-")
  return Schema.decodeUnknownSync(BotId)(`bot_${uuid}`)
}

export interface BotRegistryShape {
  readonly syncFromDir: (dir: string) => Effect.Effect<ReadonlyArray<Bot>, SchemaViolation | SqlError>
  readonly upsert: (bot: NewBot, by: string) => Effect.Effect<Bot, SqlError | Conflict>
  // Replaces the definition of an existing Bot (same id and name) and appends bot.updated in the same transaction.
  readonly update: (
    id: BotId,
    next: NewBot,
    by: string,
  ) => Effect.Effect<Bot & { readonly state: BotState }, NotFound | SqlError | Conflict>
  readonly get: (id: BotId) => Effect.Effect<Bot, NotFound | SqlError>
  readonly getByName: (name: string) => Effect.Effect<Bot, NotFound | SqlError>
  readonly list: () => Effect.Effect<ReadonlyArray<Bot & { state: BotState }>, SqlError>
  readonly setState: (id: BotId, state: BotState, taskId?: TaskId) => Effect.Effect<void, SqlError>
}

export class BotRegistry extends Context.Service<BotRegistry, BotRegistryShape>()("@shoalwork/BotRegistry") {}

// A bot record is only written together with its event, so a rejected event is a bug (defect), not a result.
const appendEvent = (beacon: BeaconShape, event: NewEvent): Effect.Effect<void, Conflict | SqlError> =>
  beacon.append(event).pipe(
    Effect.catchTag("SchemaViolation", (e) => Effect.die(e)),
    Effect.asVoid,
  )

// Top-level fields a PATCH may change. `executors` is split into the two lists the event names.
const EDITABLE_TOP = [
  "role",
  "instructions",
  "kind",
  "modelTiers",
  "connectors",
  "budget",
  "policy",
  "tank",
  "memory",
  "telegram",
] as const

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

const changedFields = (a: Bot, b: Bot): Array<string> => {
  const fields: Array<string> = []
  if (differs(a.executors.preferred, b.executors.preferred)) fields.push("executors.preferred")
  if (differs(a.executors.allowed, b.executors.allowed)) fields.push("executors.allowed")
  for (const key of EDITABLE_TOP) {
    if (differs(a[key], b[key])) fields.push(key)
  }
  return fields
}

const isSensitiveField = (field: string): boolean => SENSITIVE_BOT_FIELDS.includes(field)

const makeRegistry = (sql: SqlClient, beacon: BeaconShape): BotRegistryShape => {
  // Insert or update by name, inside one write transaction. The id of an existing name is never changed.
  // A new bot also gets its bot.created event in the same transaction (nested savepoint inside Beacon).
  const writeBot = (
    bot: NewBot,
    by: string,
    sourcePath: string | null,
  ): Effect.Effect<Bot, Conflict | SqlError> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM bots WHERE name = ${bot.name}`
        const [existing] = yield* decodeBotRows(rows)
        const now = nowIso()
        if (existing !== undefined) {
          const full: Bot = { ...bot, id: existing.id }
          yield* sql`UPDATE bots SET definition = ${JSON.stringify(full)},
            source_path = COALESCE(${sourcePath}, source_path), updated_at = ${now}
            WHERE id = ${existing.id}`
          return full
        }
        const full: Bot = { ...bot, id: botIdFor(bot.name) }
        yield* sql`INSERT INTO bots (id, name, definition, state, source_path, updated_at)
          VALUES (${full.id}, ${full.name}, ${JSON.stringify(full)}, 'idle', ${sourcePath}, ${now})`
        yield* appendEvent(beacon, {
          streamId: streamIds.bot(full.id),
          type: "bot.created",
          payload: { bot: full, by },
          actor: by,
          correlationId: randomUUID(),
        })
        return full
      }),
    )

  const botOrNotFound = (rows: ReadonlyArray<unknown>, lookup: string): Effect.Effect<Bot, NotFound> =>
    Effect.gen(function* () {
      const [row] = yield* decodeBotRows(rows)
      if (row === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Bot", id: lookup }))
      }
      return yield* decodeStoredBot(row)
    })

  return {
    syncFromDir: (dir) =>
      Effect.gen(function* () {
        const entries = yield* loadBotEntries(dir)
        const bots: Array<Bot> = []
        for (const { path, bot } of entries) {
          bots.push(
            yield* writeBot(bot, "system:loader", path).pipe(
              Effect.catchTag("Conflict", (e) => Effect.die(e)),
            ),
          )
        }
        return bots
      }),

    upsert: (bot, by) => writeBot(bot, by, null),

    update: (id, next, by) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT * FROM bots WHERE id = ${id}`
          const [row] = yield* decodeBotRows(rows)
          if (row === undefined) {
            return yield* Effect.fail(new NotFound({ entity: "Bot", id }))
          }
          const current = yield* decodeStoredBot(row)
          if (current.name !== next.name) {
            return yield* Effect.die(new Error("bot name is immutable"))
          }
          const full: Bot = { ...next, id }
          const fields = changedFields(current, full)
          yield* sql`UPDATE bots SET definition = ${JSON.stringify(full)}, updated_at = ${nowIso()} WHERE id = ${id}`
          if (fields.length > 0) {
            yield* appendEvent(beacon, {
              streamId: streamIds.bot(id),
              type: "bot.updated",
              payload: { botId: id, fields, by, sensitive: fields.some(isSensitiveField) },
              actor: by,
              correlationId: randomUUID(),
            })
          }
          return { ...full, state: row.state }
        }),
      ),

    get: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM bots WHERE id = ${id}`
        return yield* botOrNotFound(rows, id)
      }),

    getByName: (name) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM bots WHERE name = ${name}`
        return yield* botOrNotFound(rows, name)
      }),

    list: () =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM bots ORDER BY name`
        const decoded = yield* decodeBotRows(rows)
        return yield* Effect.forEach(decoded, (row) =>
          decodeStoredBot(row).pipe(Effect.map((bot) => ({ ...bot, state: row.state }))),
        )
      }),

    setState: (id, state, taskId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`SELECT state FROM bots WHERE id = ${id}`
            const [current] = yield* decodeStateRows(rows)
            if (current === undefined) {
              return yield* Effect.die(new NotFound({ entity: "Bot", id }))
            }
            yield* sql`UPDATE bots SET state = ${state}, updated_at = ${nowIso()} WHERE id = ${id}`
            yield* appendEvent(beacon, {
              streamId: streamIds.bot(id),
              type: "bot.state_changed",
              payload: {
                botId: id,
                from: current.state,
                to: state,
                ...(taskId === undefined ? {} : { taskId }),
              },
              actor: "system:registry",
              correlationId: taskId ?? randomUUID(),
            }).pipe(Effect.catchTag("Conflict", (e) => Effect.die(e)))
          }),
        )
        .pipe(Effect.asVoid),
  }
}

export const BotRegistryLive: Layer.Layer<BotRegistry, never, SqlClient | Beacon> = Layer.effect(
  BotRegistry,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    return makeRegistry(sql, beacon)
  }),
)
