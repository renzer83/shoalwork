import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { startCycle } from "../src/cycle-rows.js"
import { ORPHAN_MS } from "../src/cycle-text.js"
import { makeScene, type Scene, TestLayer } from "./cycle-support.js"

const base = {
  project: "demo",
  phase: "work",
  currentTaskId: null,
  workerTasks: [],
  fixes: 0,
  ciSignal: null,
  sinceMs: 0,
  checkedMs: null,
  approvalId: null,
  fixNote: null,
} as const

const recoveries = (scene: Scene) =>
  Effect.gen(function* () {
    const events = Array.from(yield* Stream.runCollect(scene.beacon.readAll(0, ["watchdog.recovered"])))
    return events.map((event) => event.payload)
  })

describe("a handoff repeated after a crash", () => {
  it.effect("does not create a second fix worker", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      const first = yield* scene.currentOf(id)
      yield* scene.workerDone(first)
      yield* scene.pass
      yield* scene.ci("failure")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("fix")
      const fix = yield* scene.currentOf(id)
      expect(scene.fake.store.size).toBe(2)

      // The crash came after the handoff and before the cycle row recorded it.
      yield* scene.sql`UPDATE project_cycles SET phase = 'fix_wait', current_task_id = ${first},
        worker_tasks = ${JSON.stringify([first])} WHERE task_id = ${id}`
      yield* scene.pass
      expect(scene.fake.store.size).toBe(2)
      expect(yield* scene.currentOf(id)).toBe(fix)
      expect(yield* scene.phaseOf(id)).toBe("fix")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("does not create a second testpilot task", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      const worker = yield* scene.currentOf(id)
      yield* scene.workerDone(worker)
      yield* scene.pass
      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
      const pilot = yield* scene.currentOf(id)

      yield* scene.sql`UPDATE project_cycles SET phase = 'ci', ci_signal = 'success', current_task_id = ${worker}
        WHERE task_id = ${id}`
      yield* scene.pass
      expect(scene.fake.store.size).toBe(2)
      expect(yield* scene.currentOf(id)).toBe(pilot)
      expect(yield* scene.phaseOf(id)).toBe("e2e")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("the sweep of cycles that lost their task", () => {
  it.effect("adopts the worker task the intake created when the cycle row never recorded it", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      const worker = yield* scene.currentOf(id)
      yield* scene.sql`UPDATE project_cycles SET current_task_id = NULL, worker_tasks = '[]' WHERE task_id = ${id}`

      expect(yield* scene.scheduler.sweep).toBe(0)
      yield* TestClock.adjust(ORPHAN_MS + 1000)
      expect(yield* scene.scheduler.sweep).toBe(1)
      expect(yield* scene.currentOf(id)).toBe(worker)
      expect(scene.fake.store.size).toBe(1)
      expect(JSON.stringify(yield* recoveries(scene))).toContain("orphan cycle adopted")

      // The cycle goes on from the adopted task.
      yield* scene.workerDone(worker)
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("gives the board task back to the queue when no Lead task exists, and starts it again", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue("in_progress")
      yield* startCycle(scene.sql, { ...base, taskId: id })
      yield* TestClock.adjust(ORPHAN_MS + 1000)

      expect(yield* scene.scheduler.sweep).toBe(1)
      expect(yield* scene.stateOf(id)).toBe("ready")
      expect(yield* scene.phaseOf(id)).toBe("settled")

      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("in_progress")
      expect(yield* scene.phaseOf(id)).toBe("work")
      expect(scene.fake.store.size).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("queues again a task in progress that has no cycle, once it is old enough", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      yield* TestClock.setTime(Date.now())
      const old = yield* scene.addIssue("in_progress", "2000-01-01T00:00:00.000Z")
      const fresh = yield* scene.addIssue("in_progress", new Date().toISOString())
      expect(yield* scene.scheduler.sweep).toBe(1)
      expect(yield* scene.stateOf(old)).toBe("ready")
      expect(yield* scene.stateOf(fresh)).toBe("in_progress")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks a fix that has no task to continue", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue("in_progress")
      yield* startCycle(scene.sql, { ...base, taskId: id, phase: "fix_wait" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
    }).pipe(Effect.provide(TestLayer)),
  )
})
