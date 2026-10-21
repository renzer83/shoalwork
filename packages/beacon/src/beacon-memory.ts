import { Conflict, decodeNewEvent, Event, type NewEvent, newEventId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { DateTime, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"
import { Beacon, type BeaconShape, checkExpectedVersion, publishAll, subscribeTo } from "./beacon.js"

// In-memory twin of BeaconLive for tests of other packages. Same contract and the same conflict rules.

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

// Pure: the batch is appended to `store` whole, or rejected whole. Each event reads the head it will extend,
// so `expectedVersion` (single-event batches only) is checked against the same state the event is written to.
const appendBatch = (
  store: ReadonlyArray<Event>,
  batch: ReadonlyArray<NewEvent>,
  occurredAt: string,
  expectedVersion: number | undefined,
): readonly [Outcome, ReadonlyArray<Event>] => {
  let working = store
  const written: Array<Event> = []
  for (const e of batch) {
    const last = lastVersionIn(working, e.streamId)
    if (expectedVersion !== undefined && last !== expectedVersion) {
      return [{ _tag: "Rejected", conflict: new Conflict({ streamId: e.streamId, expectedVersion }) }, store]
    }
    const event = Schema.decodeUnknownSync(Event)({
      id: newEventId(),
      streamId: e.streamId,
      version: last + 1,
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
        const expected = opts?.expectedVersion
        yield* checkExpectedVersion(expected)
        const written = yield* commit([valid], expected)
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

    // Same half-open window as the SQL version: since <= occurredAt < until.
    const readRange: BeaconShape["readRange"] = (types, window) =>
      Stream.fromIterableEffect(
        Ref.get(store).pipe(
          Effect.map((events) => {
            if (types.length === 0) {
              return []
            }
            const wanted = new Set<string>(types)
            return events.filter((event) => {
              const at = DateTime.toEpochMillis(event.occurredAt)
              return wanted.has(event.type) && at >= window.since && at < window.until
            })
          }),
        ),
      )

    return {
      append,
      appendMany,
      readStream,
      readAll,
      readRange,
      subscribe: (types) => subscribeTo(pubsub, types),
      lastVersion: (streamId) => Ref.get(store).pipe(Effect.map((events) => lastVersionIn(events, streamId))),
    }
  }),
)
