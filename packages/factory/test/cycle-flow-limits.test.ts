import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { errorsOf, makeScene, TestLayer } from "./cycle-support.js"

describe("the delivery cycle: limits and failures", () => {
  it.effect("respects the WIP limit with five issues and starts the next one when a slot frees", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ maxInProgress: 3 })
      const ids: Array<string> = []
      for (let n = 0; n < 5; n += 1) ids.push(yield* scene.addIssue())

      yield* scene.pass
      yield* scene.pass
      const states = yield* Effect.forEach(ids, scene.stateOf)
      expect(states.filter((state) => state === "in_progress").length).toBe(3)
      expect(states.filter((state) => state === "ready").length).toBe(2)
      expect(scene.fake.store.size).toBe(3)

      const first = ids[0] ?? ""
      yield* scene.workerDone(yield* scene.currentOf(first))
      yield* scene.pass
      const after = yield* Effect.forEach(ids, scene.stateOf)
      expect(after.filter((state) => state === "in_progress").length).toBe(3)
      expect(after.filter((state) => state === "ready").length).toBe(1)
      expect(scene.fake.store.size).toBe(4)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the same pass or ci result twice dispatches once", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.pass
      yield* scene.pass
      expect(scene.fake.store.size).toBe(1)

      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      yield* scene.ci("success")
      yield* scene.ci("success")
      yield* scene.pass
      yield* scene.pass
      // worker + testpilot only
      expect(scene.fake.store.size).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks a task whose worker ended without a pull request", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.fake.finish(yield* scene.currentOf(id), { result: "nothing to do" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect((yield* errorsOf(scene)).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks a task whose worker task failed", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.fake.finish(yield* scene.currentOf(id), { kind: "failed", state: "failed" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks the task when the handoff is refused by the message limit", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      scene.fake.flags.refuseHandoff = true
      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
    }).pipe(Effect.provide(TestLayer)),
  )
})
