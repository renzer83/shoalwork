import {
  Conflict,
  decodeNewEvent,
  Event,
  type EventId,
  type EventType,
  type NewEvent,
  newEventId,
  SchemaViolation,
} from "@shoalwork/contracts"
import { EventRow, nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export interface AppendOptions {
  readonly expectedVersion?: number | undefined
}

export interface BeaconShape {
  readonly append: (
    e: NewEvent,
    opts?: AppendOptions,
  ) => Effect.Effect<Event, Conflict | SchemaViolation | SqlError>
  readonly appendMany: (
    es: ReadonlyArray<NewEvent>,
  ) => Effect.Effect<ReadonlyArray<Event>, Conflict | SchemaViolation | SqlError>
  readonly readStream: (streamId: string, afterVersion?: number) => Stream.Stream<Event, SqlError>
  readonly readAll: (
    afterPosition?: number,
    types?: ReadonlyArray<EventType>,
  ) => Stream.Stream<Event, SqlError>
  readonly subscribe: (types?: ReadonlyArray<EventType>) => Stream.Stream<Event>
  readonly lastVersion: (streamId: string) => Effect.Effect<number, SqlError>
}

export class Beacon extends Context.Service<Beacon, BeaconShape>()("@shoalwork/Beacon") {}

// Attempts for append without expectedVersion. Inside one BEGIN IMMEDIATE transaction a retry should not
// happen; it is a safety net against a UNIQUE (stream_id, version) race from another connection.
const MAX_APPEND_ATTEMPTS = 3

// Shared by both backends. Only expectedVersion values that can name a real version are accepted.
export const checkExpectedVersion = (expected: number | undefined): Effect.Effect<void, SchemaViolation> =>
  expected === undefined || (Number.isInteger(expected) && expected >= 0)
    ? Effect.void
    : Effect.fail(new SchemaViolation({ where: "expectedVersion", issue: expected }))

const VersionRow = Schema.Struct({ version: Schema.Int })
const decodeVersionRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(VersionRow))(rows).pipe(Effect.orDie)
const decodeEventRow = Schema.decodeUnknownEffect(EventRow)
const decodeEvent = Schema.decodeUnknownEffect(Event)

// Rows are written by this package only: a mismatch is a bug, so it dies instead of becoming a typed error.
const rowToEvent = (row: EventRow): Effect.Effect<Event> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: (): unknown => JSON.parse(row.payload),
      catch: (cause) => cause,
    }).pipe(Effect.orDie)
    return yield* decodeEvent({
      id: row.id,
      streamId: row.stream_id,
      version: row.version,
      position: row.position,
      type: row.type,
      payload,
      actor: row.actor,
      correlationId: row.correlation_id,
      ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
      occurredAt: row.occurred_at,
    }).pipe(Effect.orDie)
  })

const decodeEventRows = (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<Event>> =>
  Effect.forEach(rows, (raw) => decodeEventRow(raw).pipe(Effect.orDie, Effect.flatMap(rowToEvent)))

const lastVersionOf = (sql: SqlClient, streamId: string): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT COALESCE(MAX(version), 0) AS version FROM events WHERE stream_id = ${streamId}`
    const [row] = yield* decodeVersionRows(rows)
    return row?.version ?? 0
  })

const insertRow = (
  sql: SqlClient,
  e: NewEvent,
  id: EventId,
  version: number,
  occurredAt: string,
): Effect.Effect<Event, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql`INSERT INTO events
      (id, stream_id, version, type, payload, actor, correlation_id, causation_id, occurred_at)
      VALUES (${id}, ${e.streamId}, ${version}, ${e.type}, ${JSON.stringify(e.payload)}, ${e.actor},
        ${e.correlationId}, ${e.causationId ?? null}, ${occurredAt})
      RETURNING *`
    const [event] = yield* decodeEventRows(rows)
    if (event === undefined) {
      return yield* Effect.die("INSERT ... RETURNING produced no row")
    }
    return event
  })

// The UNIQUE (stream_id, version) constraint is the last line of defence for concurrent writers.
const isVersionConflict = (error: SqlError): boolean =>
  error.reason._tag === "UniqueViolation" &&
  error.reason.constraint.includes("stream_id") &&
  error.reason.constraint.includes("version")

// Insert at `base + 1`; a UNIQUE violation on the version becomes Conflict.
const insertAt = (
  sql: SqlClient,
  e: NewEvent,
  id: EventId,
  occurredAt: string,
  base: number,
): Effect.Effect<Event, Conflict | SqlError> =>
  insertRow(sql, e, id, base + 1, occurredAt).pipe(
    Effect.catchIf(isVersionConflict, () =>
      Effect.fail(new Conflict({ streamId: e.streamId, expectedVersion: base })),
    ),
  )

// Read the head, check expectedVersion, insert: all in one BEGIN IMMEDIATE transaction, so no other writer
// can move the head between the check and the insert.
const writeAtHead = (
  sql: SqlClient,
  e: NewEvent,
  id: EventId,
  occurredAt: string,
  expected: number | undefined,
): Effect.Effect<Event, Conflict | SqlError> =>
  sql.withTransaction(
    Effect.gen(function* () {
      const last = yield* lastVersionOf(sql, e.streamId)
      if (expected !== undefined && last !== expected) {
        return yield* Effect.fail(new Conflict({ streamId: e.streamId, expectedVersion: expected }))
      }
      return yield* insertAt(sql, e, id, occurredAt, last)
    }),
  )

const appendRetrying = (
  sql: SqlClient,
  e: NewEvent,
  id: EventId,
  occurredAt: string,
  attempt: number,
): Effect.Effect<Event, Conflict | SqlError> =>
  writeAtHead(sql, e, id, occurredAt, undefined).pipe(
    Effect.catchTag("Conflict", (conflict) =>
      attempt < MAX_APPEND_ATTEMPTS
        ? appendRetrying(sql, e, id, occurredAt, attempt + 1)
        : Effect.fail(conflict),
    ),
  )

export const publishAll = (pubsub: PubSub.PubSub<Event>, events: ReadonlyArray<Event>): Effect.Effect<void> =>
  Effect.forEach(events, (event) => PubSub.publish(pubsub, event)).pipe(Effect.asVoid)

export const subscribeTo = (pubsub: PubSub.PubSub<Event>, types?: ReadonlyArray<EventType>) => {
  const live = Stream.fromPubSub(pubsub)
  if (types === undefined || types.length === 0) {
    return live
  }
  const wanted = new Set<string>(types)
  return live.pipe(Stream.filter((event) => wanted.has(event.type)))
}

const makeLive = (sql: SqlClient, pubsub: PubSub.PubSub<Event>): BeaconShape => {
  const append: BeaconShape["append"] = (e, opts) =>
    Effect.gen(function* () {
      const valid = yield* decodeNewEvent(e)
      const expected = opts?.expectedVersion
      yield* checkExpectedVersion(expected)
      const id = newEventId()
      const occurredAt = nowIso()
      const event =
        expected === undefined
          ? yield* appendRetrying(sql, valid, id, occurredAt, 1)
          : yield* writeAtHead(sql, valid, id, occurredAt, expected)
      // position is the source of ordering; publish is best-effort after commit.
      yield* PubSub.publish(pubsub, event)
      return event
    })

  const appendMany: BeaconShape["appendMany"] = (es) =>
    Effect.gen(function* () {
      const valid = yield* Effect.forEach(es, (raw) => decodeNewEvent(raw))
      const occurredAt = nowIso()
      // One write transaction: every event lands or none does.
      const events = yield* sql.withTransaction(
        Effect.gen(function* () {
          const written: Array<Event> = []
          const heads = new Map<string, number>()
          for (const e of valid) {
            const base = heads.get(e.streamId) ?? (yield* lastVersionOf(sql, e.streamId))
            const event = yield* insertAt(sql, e, newEventId(), occurredAt, base)
            heads.set(e.streamId, event.version)
            written.push(event)
          }
          return written
        }),
      )
      yield* publishAll(pubsub, events)
      return events
    })

  const readStream: BeaconShape["readStream"] = (streamId, afterVersion = 0) =>
    Stream.fromIterableEffect(
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM events
          WHERE stream_id = ${streamId} AND version > ${afterVersion} ORDER BY version`
        return yield* decodeEventRows(rows)
      }),
    )

  // Empty or missing `types` means no type filter.
  const readAll: BeaconShape["readAll"] = (afterPosition = 0, types) =>
    Stream.fromIterableEffect(
      Effect.gen(function* () {
        const rows =
          types === undefined || types.length === 0
            ? yield* sql`SELECT * FROM events WHERE position > ${afterPosition} ORDER BY position`
            : yield* sql`SELECT * FROM events
                WHERE position > ${afterPosition} AND ${sql.in("type", types)} ORDER BY position`
        return yield* decodeEventRows(rows)
      }),
    )

  return {
    append,
    appendMany,
    readStream,
    readAll,
    subscribe: (types) => subscribeTo(pubsub, types),
    lastVersion: (streamId) => lastVersionOf(sql, streamId),
  }
}

export const BeaconLive: Layer.Layer<Beacon, never, SqlClient> = Layer.effect(
  Beacon,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const pubsub = yield* PubSub.unbounded<Event>()
    return makeLive(sql, pubsub)
  }),
)
