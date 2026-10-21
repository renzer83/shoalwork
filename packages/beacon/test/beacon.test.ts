import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Conflict, type NewEvent, SchemaViolation, streamIds, TaskId } from "@shoalwork/contracts"
import { makeDbLayer, runMigrations } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { Beacon, BeaconLive, type BeaconShape } from "../src/index.js"

// Real SQLite per test (fresh file, migrations applied).
const TestLayer = Layer.provideMerge(BeaconLive, withTempDb())

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const TASK_ID = Schema.decodeUnknownSync(TaskId)(TASK)
const USAGE = { tokensIn: 1200, tokensOut: 300, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 42 }

const stateChanged = (to: "planning" | "running" | "done"): NewEvent => ({
  streamId: streamIds.task(TASK_ID),
  type: "task.state_changed",
  payload: { taskId: TASK, from: "received", to },
  actor: "system:watchdog",
  correlationId: "corr_beacon_test",
})

const usageRecorded = (): NewEvent => ({
  streamId: streamIds.task(TASK_ID),
  type: "usage.recorded",
  payload: { taskId: TASK, botId: BOT, executor: "claude-code", model: "haiku", usage: USAGE },
  actor: `bot:${BOT}`,
  correlationId: "corr_beacon_test",
})

const removeDbFiles = (path: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

describe("Beacon (SQLite)", () => {
  it.effect("append three events to one stream assigns versions 1, 2, 3", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const first = yield* beacon.append(stateChanged("planning"))
      const second = yield* beacon.append(stateChanged("running"))
      const third = yield* beacon.append(stateChanged("done"))
      expect([first.version, second.version, third.version]).toEqual([1, 2, 3])
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(3)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("lastVersion is 0 for a stream with no events", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("append with a stale expectedVersion fails with Conflict", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.append(stateChanged("planning"))
      yield* beacon.append(stateChanged("running"))
      const error = yield* Effect.flip(beacon.append(stateChanged("done"), { expectedVersion: 1 }))
      expect(error).toBeInstanceOf(Conflict)
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("expectedVersion 5 on an empty stream fails with Conflict", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const error = yield* Effect.flip(beacon.append(stateChanged("planning"), { expectedVersion: 5 }))
      expect(error).toBeInstanceOf(Conflict)
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(0)
      expect(yield* Stream.runCollect(beacon.readAll())).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("expectedVersion -1 and 2.5 are rejected with SchemaViolation", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const negative = yield* Effect.flip(beacon.append(stateChanged("planning"), { expectedVersion: -1 }))
      const fractional = yield* Effect.flip(beacon.append(stateChanged("planning"), { expectedVersion: 2.5 }))
      expect(negative).toBeInstanceOf(SchemaViolation)
      expect(fractional).toBeInstanceOf(SchemaViolation)
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("append with a matching expectedVersion succeeds", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.append(stateChanged("planning"))
      const next = yield* beacon.append(stateChanged("running"), { expectedVersion: 1 })
      expect(next.version).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("append rejects an invalid payload with SchemaViolation", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const error = yield* Effect.flip(
        beacon.append({ ...stateChanged("planning"), payload: { taskId: "not-a-task-id" } }),
      )
      expect(error).toBeInstanceOf(SchemaViolation)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("appendMany writes nothing when the second payload is invalid", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const error = yield* Effect.flip(
        beacon.appendMany([
          stateChanged("planning"),
          { ...stateChanged("running"), payload: { bogus: true } },
        ]),
      )
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(0)
      const all = yield* Stream.runCollect(beacon.readAll())
      expect(all).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("appendMany writes a valid batch with consecutive versions", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const written = yield* beacon.appendMany([stateChanged("planning"), stateChanged("running")])
      expect(written.map((e) => e.version)).toEqual([1, 2])
      const [first, second] = written
      expect(first !== undefined && second !== undefined && second.position > first.position).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("20 concurrent appends to one stream get versions 1..20 with no gaps and no Conflict", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const written = yield* Effect.all(
        Array.from({ length: 20 }, () => beacon.append(stateChanged("planning"))),
        { concurrency: "unbounded" },
      )
      expect(written.map((e) => e.version).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      )
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(20)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("two connections to one file append to one stream without gaps", () => {
    const path = join(tmpdir(), `shoalwork-beacon-${randomUUID()}.db`)
    const writer = Layer.provide(BeaconLive, makeDbLayer(path))
    const appendTen = Effect.gen(function* () {
      const beacon: BeaconShape = yield* Beacon
      return yield* Effect.all(
        Array.from({ length: 10 }, () => beacon.append(stateChanged("planning"))),
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provide(writer))
    return Effect.gen(function* () {
      yield* runMigrations.pipe(Effect.provide(makeDbLayer(path)))
      const [fromA, fromB] = yield* Effect.all([appendTen, appendTen], { concurrency: "unbounded" })
      const versions = [...fromA, ...fromB].map((e) => e.version).sort((a, b) => a - b)
      expect(versions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => removeDbFiles(path))))
  })

  it.effect("readStream after version 1 returns only versions 2 and 3", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany([stateChanged("planning"), stateChanged("running"), stateChanged("done")])
      const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(TASK_ID), 1))
      expect(events.map((e) => e.version)).toEqual([2, 3])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("readAll filters by event type", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany([stateChanged("planning"), usageRecorded(), usageRecorded()])
      const usage = yield* Stream.runCollect(beacon.readAll(0, ["usage.recorded"]))
      expect(usage.map((e) => e.type)).toEqual(["usage.recorded", "usage.recorded"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("subscribe keeps an event published before the stream is pulled", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const live = yield* beacon.subscribe()
      yield* beacon.append(stateChanged("planning")).pipe(Effect.orDie)
      const delivered = yield* Stream.runCollect(live.pipe(Stream.take(1)))
      expect(delivered.map((e) => e.type)).toEqual(["task.state_changed"])
      expect(delivered[0]?.streamId).toBe(streamIds.task(TASK_ID))
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )

  it.effect("subscribe(types) delivers only the requested types", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const live = yield* beacon.subscribe(["usage.recorded"])
      yield* beacon
        .appendMany([stateChanged("planning"), usageRecorded(), stateChanged("running"), usageRecorded()])
        .pipe(Effect.orDie)
      const delivered = yield* Stream.runCollect(live.pipe(Stream.take(2)))
      expect(delivered.map((e) => e.type)).toEqual(["usage.recorded", "usage.recorded"])
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})

describe("Beacon.readRange (SQLite)", () => {
  it.effect("returns only the given types inside the window, in log order", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const first = yield* beacon.append(usageRecorded())
      yield* beacon.append(stateChanged("running"))
      const second = yield* beacon.append(usageRecorded())
      const at = DateTime.toEpochMillis(first.occurredAt)
      const wide = { since: at - 60_000, until: at + 60_000 }
      const found = yield* Stream.runCollect(beacon.readRange(["usage.recorded"], wide))
      expect(found.map((event) => event.id)).toEqual([first.id, second.id])
      expect(yield* Stream.runCollect(beacon.readRange([], wide))).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the window is half-open: since is included, until is left out", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const event = yield* beacon.append(usageRecorded())
      const at = DateTime.toEpochMillis(event.occurredAt)
      const included = yield* Stream.runCollect(
        beacon.readRange(["usage.recorded"], { since: at, until: at + 1 }),
      )
      expect(included.map((e) => e.id)).toEqual([event.id])
      const excluded = yield* Stream.runCollect(
        beacon.readRange(["usage.recorded"], { since: at - 1000, until: at }),
      )
      expect(excluded).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})
