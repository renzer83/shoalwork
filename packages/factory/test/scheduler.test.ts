import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { newTaskId, streamIds } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { CI_POLL_MS, CI_SILENCE_MS } from "../src/cycle-text.js"
import { KanbanLive } from "../src/kanban-live.js"
import { makeScene, type Scene } from "./cycle-support.js"

const TestLayer = Layer.provideMerge(
  Layer.mergeAll(KanbanLive, BotRegistryLive),
  Layer.provideMerge(BeaconTest, withTempDb()),
)

const recoveries = (scene: Scene) =>
  Effect.gen(function* () {
    const events = Array.from(yield* Stream.runCollect(scene.beacon.readStream(streamIds.system)))
    return events.filter((event) => event.type === "watchdog.recovered")
  })

describe("FactoryScheduler.tick", () => {
  it.effect("runs one pass for every active project and skips the others", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      expect(yield* scene.scheduler.tick).toBe(1)
      expect(yield* scene.stateOf(id)).toBe("in_progress")

      yield* scene.sql`UPDATE projects SET status = 'paused' WHERE slug = 'demo'`
      const other = yield* scene.addIssue()
      expect(yield* scene.scheduler.tick).toBe(0)
      expect(yield* scene.stateOf(other)).toBe("ready")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("moves the ci result of the log onto the cycle of the branch", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.scheduler.tick
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.scheduler.tick
      yield* scene.ci("success")
      yield* scene.scheduler.tick
      expect(yield* scene.phaseOf(id)).toBe("e2e")
      // The cursor moved on: the same result is not read again.
      const rows = yield* scene.sql`SELECT position FROM project_cycle_cursors WHERE project = 'demo'`
      expect(rows.length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a ci result for another repository does not touch the cycle", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.scheduler.tick
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.scheduler.tick
      yield* scene.ci("success", "some/other-branch")
      yield* scene.scheduler.tick
      expect(yield* scene.phaseOf(id)).toBe("ci")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("FactoryScheduler.onEvent", () => {
  it.effect("a github event of the project's repository wakes the pass", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      const event = yield* scene.ci("success", "x")
      expect(yield* scene.scheduler.onEvent(event)).toBe(true)
      expect(yield* scene.stateOf(id)).toBe("in_progress")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("never wakes on its own writes or on events of another type", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      yield* scene.addIssue()
      const own = yield* scene.beacon.append({
        streamId: streamIds.system,
        type: "github.workflow_run",
        payload: {
          deliveryId: "d1",
          repo: "acme/demo",
          action: "completed",
          sender: "x",
          url: "u",
          botAuthored: false,
        },
        actor: "system:factory",
        correlationId: "c",
      })
      expect(yield* scene.scheduler.onEvent(own)).toBe(false)
      const other = yield* scene.beacon.append({
        streamId: streamIds.system,
        type: "watchdog.recovered",
        payload: { what: "state_mismatch", ref: "r", action: "a" },
        actor: "github",
        correlationId: "c",
      })
      expect(yield* scene.scheduler.onEvent(other)).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("ignores an event of a repository no project owns", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      const stranger = yield* scene.beacon.append({
        streamId: streamIds.system,
        type: "github.workflow_run",
        payload: {
          deliveryId: "d2",
          repo: "someone/else",
          action: "completed",
          sender: "x",
          url: "u",
          botAuthored: false,
        },
        actor: "github",
        correlationId: "c",
      })
      expect(yield* scene.scheduler.onEvent(stranger)).toBe(false)
      expect(yield* scene.stateOf(id)).toBe("ready")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a finished lead task wakes the project that waits for it", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.scheduler.tick
      const worker = yield* scene.currentOf(id)
      yield* scene.workerDone(worker)
      const event = yield* scene.beacon.append({
        streamId: streamIds.task(worker),
        type: "task.state_changed",
        payload: { taskId: worker, from: "running", to: "done" },
        actor: "system:lead",
        correlationId: worker,
      })
      expect(yield* scene.scheduler.onEvent(event)).toBe(true)
      expect(yield* scene.phaseOf(id)).toBe("ci")

      // A task nobody waits for wakes nothing.
      const stray = yield* scene.beacon.append({
        streamId: streamIds.task(worker),
        type: "task.state_changed",
        payload: { taskId: newTaskId(), from: "running", to: "done" },
        actor: "system:lead",
        correlationId: "c",
      })
      expect(yield* scene.scheduler.onEvent(stray)).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a burst of events runs the pass once per cooldown", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      yield* scene.addIssue()
      const first = yield* scene.ci("success", "x")
      const second = yield* scene.ci("success", "y")
      expect(yield* scene.scheduler.onEvent(first)).toBe(true)
      expect(yield* scene.scheduler.onEvent(second)).toBe(false)
      yield* TestClock.adjust("3 seconds")
      expect(yield* scene.scheduler.onEvent(second)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("FactoryScheduler.sweep", () => {
  const toCi = (scene: Scene) =>
    Effect.gen(function* () {
      const id = yield* scene.addIssue()
      yield* scene.scheduler.tick
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.scheduler.tick
      expect(yield* scene.phaseOf(id)).toBe("ci")
      return id
    })

  it.effect("leaves a pull request alone while the ci events are recent", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      yield* toCi(scene)
      yield* TestClock.adjust(CI_SILENCE_MS - 1000)
      expect(yield* scene.scheduler.sweep).toBe(0)
      expect(scene.gh.calls.filter((call) => call.method === "prChecks").length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("polls the checks of a pull request silent for over 20 minutes and moves the cycle on", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* TestClock.adjust(CI_SILENCE_MS + 1000)
      scene.pr.checks = "pass"
      expect(yield* scene.scheduler.sweep).toBe(1)
      expect(scene.gh.calls.filter((call) => call.method === "prChecks").length).toBe(1)
      expect(yield* scene.phaseOf(id)).toBe("e2e")
      expect((yield* recoveries(scene)).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failing poll sends the fix and a pending one is asked again later, not at once", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* TestClock.adjust(CI_SILENCE_MS + 1000)
      scene.pr.checks = "pending"
      expect(yield* scene.scheduler.sweep).toBe(0)
      expect(yield* scene.scheduler.sweep).toBe(0)
      expect(scene.gh.calls.filter((call) => call.method === "prChecks").length).toBe(1)

      yield* TestClock.adjust(CI_POLL_MS + 1000)
      scene.pr.checks = "fail"
      expect(yield* scene.scheduler.sweep).toBe(1)
      expect(yield* scene.phaseOf(id)).toBe("fix")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("puts a task in review without a pull request back in the queue", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue("in_review")
      expect(yield* scene.scheduler.sweep).toBe(1)
      // The same pass starts it again.
      expect(["ready", "in_progress"]).toContain(yield* scene.stateOf(id))
      expect((yield* recoveries(scene)).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("FactoryScheduler.start", () => {
  it.live("runs the periodic pass in the background until the scope closes", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.scheduler.start({ pollMs: 20 })
      yield* scene.stateOf(id).pipe(
        Effect.filterOrFail(
          (state) => state === "in_progress",
          () => "not started yet",
        ),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
      )
      expect(yield* scene.stateOf(id)).toBe("in_progress")
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  )
})
