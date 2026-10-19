import {
  Conflict,
  decodeNewEvent,
  Event,
  type EventId,
  type EventType,
  type NewEvent,
  newEventId,
  type SchemaViolation,
} from "@shoalwork/contracts"
import { EventRow, nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"
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

// Attempts for append without expectedVersion: each attempt re-reads lastVersion before inserting.
const MAX_APPEND_ATTEMPTS = 3

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

// UNIQUE (stream_id, version) is the optimistic-concurrency guard. The constraint name comes from the driver.
const isVersionConflict = (error: SqlError): boolean =>
  error.reason._tag === "UniqueViolation" && error.reason.constraint.includes("stream_id")

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

const appendRetrying = (
  sql: SqlClient,
  e: NewEvent,
  id: EventId,
  occurredAt: string,
  attempt: number,
): Effect.Effect<Event, Conflict | SqlError> =>
  lastVersionOf(sql, e.streamId).pipe(
    Effect.flatMap((base) => insertAt(sql, e, id, occurredAt, base)),
    Effect.catchTag("Conflict", (conflict) =>
      attempt < MAX_APPEND_ATTEMPTS
        ? appendRetrying(sql, e, id, occurredAt, attempt + 1)
        : Effect.fail(conflict),
    ),
  )

const publishAll = (pubsub: PubSub.PubSub<Event>, events: ReadonlyArray<Event>): Effect.Effect<void> =>
  Effect.forEach(events, (event) => PubSub.publish(pubsub, event)).pipe(Effect.asVoid)

const subscribeTo = (pubsub: PubSub.PubSub<Event>, types?: ReadonlyArray<EventType>) => {
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
      const id = newEventId()
      const occurredAt = nowIso()
      const expected = opts?.expectedVersion
      const event =
        expected === undefined
          ? yield* appendRetrying(sql, valid, id, occurredAt, 1)
          : yield* insertAt(sql, valid, id, occurredAt, expected)
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

// In-memory twin of BeaconLive for tests of other packages. Same contract and conflict rules.
const lastVersionIn = (events: ReadonlyArray<Event>, streamId: string): number => {
  let version = 0
  for (const event of events) {
    if (event.streamId === streamId && event.version > version) {
      version = event.version
    }
  }
  return version
}

type Outcome =
  | { readonly _tag: "Appended"; readonly events: ReadonlyArray<Event> }
  | { readonly _tag: "Rejected"; readonly conflict: Conflict }

// Pure: the whole batch is appended to `store` or rejected. `occurredAt` is passed in so the batch is one clock reading.
const appendBatch = (
  store: ReadonlyArray<Event>,
  batch: ReadonlyArray<NewEvent>,
  occurredAt: string,
  expectedVersion: number | undefined,
): readonly [Outcome, ReadonlyArray<Event>] => {
  let working = store
  const written: Array<Event> = []
  for (const e of batch) {
    const base = expectedVersion ?? lastVersionIn(working, e.streamId)
    const version = base + 1
    if (working.some((event) => event.streamId === e.streamId && event.version === version)) {
      return [
        { _tag: "Rejected", conflict: new Conflict({ streamId: e.streamId, expectedVersion: base }) },
        store,
      ]
    }
    const event = Schema.decodeUnknownSync(Event)({
      id: newEventId(),
      streamId: e.streamId,
      version,
      position: working.length + 1,
      type: e.type,
      payload: e.payload,
      actor: e.actor,
      correlationId: e.correlationId,
      ...(e.causationId === undefined ? {} : { causationId: e.causationId }),
      occurredAt,
    })
    written.push(event)
    working = [...working, event]
  }
  return [{ _tag: "Appended", events: written }, working]
}

export const BeaconTest: Layer.Layer<Beacon> = Layer.effect(
  Beacon,
  Effect.gen(function* () {
    const store = yield* Ref.make<ReadonlyArray<Event>>([])
    const pubsub = yield* PubSub.unbounded<Event>()

    const commit = (
      batch: ReadonlyArray<NewEvent>,
      expectedVersion: number | undefined,
    ): Effect.Effect<ReadonlyArray<Event>, Conflict> =>
      Effect.gen(function* () {
        const occurredAt = nowIso()
        const outcome = yield* Ref.modify(store, (events) =>
          appendBatch(events, batch, occurredAt, expectedVersion),
        )
        if (outcome._tag === "Rejected") {
          return yield* Effect.fail(outcome.conflict)
        }
        yield* publishAll(pubsub, outcome.events)
        return outcome.events
      })

    const append: BeaconShape["append"] = (e, opts) =>
      Effect.gen(function* () {
        const valid = yield* decodeNewEvent(e)
        const written = yield* commit([valid], opts?.expectedVersion)
        const [event] = written
        if (event === undefined) {
          return yield* Effect.die("commit produced no event")
        }
        return event
      })

    const appendMany: BeaconShape["appendMany"] = (es) =>
      Effect.gen(function* () {
        const valid = yield* Effect.forEach(es, (raw) => decodeNewEvent(raw))
        return yield* commit(valid, undefined)
      })

    const readStream: BeaconShape["readStream"] = (streamId, afterVersion = 0) =>
      Stream.fromIterableEffect(
        Ref.get(store).pipe(
          Effect.map((events) =>
            events.filter((event) => event.streamId === streamId && event.version > afterVersion),
          ),
        ),
      )

    const readAll: BeaconShape["readAll"] = (afterPosition = 0, types) =>
      Stream.fromIterableEffect(
        Ref.get(store).pipe(
          Effect.map((events) => {
            const later = events.filter((event) => event.position > afterPosition)
            if (types === undefined || types.length === 0) {
              return later
            }
            const wanted = new Set<string>(types)
            return later.filter((event) => wanted.has(event.type))
          }),
        ),
      )

    return {
      append,
      appendMany,
      readStream,
      readAll,
      subscribe: (types) => subscribeTo(pubsub, types),
      lastVersion: (streamId) => Ref.get(store).pipe(Effect.map((events) => lastVersionIn(events, streamId))),
    }
  }),
)
