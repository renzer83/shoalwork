import { it } from "@effect/vitest"
import { Conflict, type Event, type NewEvent, SchemaViolation, streamIds, TaskId } from "@shoalwork/contracts"
import { Effect, Queue, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { Beacon, BeaconTest } from "../src/index.js"

// Same cases as beacon.test.ts, run against the in-memory BeaconTest layer.

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

describe("BeaconTest (in memory)", () => {
  it.effect("append three events to one stream assigns versions 1, 2, 3", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const first = yield* beacon.append(stateChanged("planning"))
      const second = yield* beacon.append(stateChanged("running"))
      const third = yield* beacon.append(stateChanged("done"))
      expect([first.version, second.version, third.version]).toEqual([1, 2, 3])
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(3)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("lastVersion is 0 for a stream with no events", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(0)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("append with a stale expectedVersion fails with Conflict", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.append(stateChanged("planning"))
      yield* beacon.append(stateChanged("running"))
      const error = yield* Effect.flip(beacon.append(stateChanged("done"), { expectedVersion: 1 }))
      expect(error).toBeInstanceOf(Conflict)
      expect(yield* beacon.lastVersion(streamIds.task(TASK_ID))).toBe(2)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("append with a matching expectedVersion succeeds", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.append(stateChanged("planning"))
      const next = yield* beacon.append(stateChanged("running"), { expectedVersion: 1 })
      expect(next.version).toBe(2)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("append rejects an invalid payload with SchemaViolation", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const error = yield* Effect.flip(
        beacon.append({ ...stateChanged("planning"), payload: { taskId: "not-a-task-id" } }),
      )
      expect(error).toBeInstanceOf(SchemaViolation)
    }).pipe(Effect.provide(BeaconTest)),
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
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("appendMany writes a valid batch with consecutive versions", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const written = yield* beacon.appendMany([stateChanged("planning"), stateChanged("running")])
      expect(written.map((e) => e.version)).toEqual([1, 2])
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("readStream after version 1 returns only versions 2 and 3", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany([stateChanged("planning"), stateChanged("running"), stateChanged("done")])
      const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(TASK_ID), 1))
      expect(events.map((e) => e.version)).toEqual([2, 3])
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("readAll filters by event type", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      yield* beacon.appendMany([stateChanged("planning"), usageRecorded(), usageRecorded()])
      const usage = yield* Stream.runCollect(beacon.readAll(0, ["usage.recorded"]))
      expect(usage.map((e) => e.type)).toEqual(["usage.recorded", "usage.recorded"])
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("subscribe receives the appended event", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const received = yield* Queue.unbounded<Event>()
      yield* Stream.runForEach(beacon.subscribe(), (event) => Queue.offer(received, event)).pipe(
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      const appended = yield* beacon.append(stateChanged("planning"))
      const delivered = yield* Queue.take(received)
      expect(delivered.id).toBe(appended.id)
    }).pipe(Effect.scoped, Effect.provide(BeaconTest)),
  )
})
