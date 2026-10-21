import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  CLAUDE,
  CODEX,
  E2E,
  errorsOf,
  GATES,
  makeScene,
  mergeCalls,
  TestLayer,
  toE2e,
  toReview,
} from "./cycle-support.js"

describe("the delivery cycle", () => {
  it.effect(
    "takes an issue to done in at most 12 passes through worker, ci, testpilot, reviewer and merge",
    () =>
      Effect.gen(function* () {
        const scene = yield* makeScene()
        const id = yield* scene.addIssue()

        yield* scene.pass
        expect(yield* scene.stateOf(id)).toBe("in_progress")
        expect(yield* scene.phaseOf(id)).toBe("work")
        const workerTask = yield* scene.currentOf(id)
        const spec = scene.fake.store.get(workerTask)?.spec
        expect(spec?.botId).toBe(scene.bots.worker.id)
        expect(spec?.acceptance).toEqual(GATES)
        expect(spec?.title.startsWith("Closes #1")).toBe(true)

        yield* scene.workerDone(workerTask)
        yield* scene.pass
        expect(yield* scene.phaseOf(id)).toBe("ci")
        expect(yield* scene.stateOf(id)).toBe("in_review")

        yield* scene.ci("success")
        yield* scene.pass
        expect(yield* scene.phaseOf(id)).toBe("e2e")
        expect(yield* scene.stateOf(id)).toBe("testing")
        const pilotTask = yield* scene.currentOf(id)
        const pilot = scene.fake.store.get(pilotTask)?.spec
        expect(pilot?.botId).toBe(scene.bots.testpilot.id)
        expect(pilot?.acceptance).toEqual(E2E)

        yield* scene.fake.finish(pilotTask, { executor: CLAUDE })
        yield* scene.pass
        expect(yield* scene.phaseOf(id)).toBe("review")
        const reviewTask = yield* scene.currentOf(id)
        const review = scene.fake.store.get(reviewTask)?.spec
        expect(review?.botId).toBe(scene.bots.reviewer.id)
        // The reviewer must not run on the executor the worker used.
        expect(review?.review?.excludeExecutors).toEqual([CLAUDE])

        yield* scene.fake.finish(reviewTask, { executor: CODEX, result: "NONE" })
        yield* scene.pass
        expect(yield* scene.phaseOf(id)).toBe("merged")
        expect(yield* scene.stateOf(id)).toBe("merging")
        expect(mergeCalls(scene).length).toBe(1)
        expect(mergeCalls(scene)[0]?.args[2]).toEqual({ squash: true, auto: true, deleteBranch: true })

        scene.pr.state = "MERGED"
        yield* scene.pass
        expect(yield* scene.stateOf(id)).toBe("done")
        expect(scene.passes()).toBeLessThanOrEqual(12)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a minor finding does not stop the merge", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), {
        executor: CODEX,
        result: "[MINOR] rename the helper",
      })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merged")
      expect(mergeCalls(scene).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failed ci sends one fix to the worker and the cycle goes on when it passes", () =>
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
      expect(yield* scene.stateOf(id)).toBe("in_progress")
      const fix = yield* scene.currentOf(id)
      expect(fix).not.toBe(first)
      const spec = scene.fake.store.get(fix)?.spec
      expect(spec?.botId).toBe(scene.bots.worker.id)
      expect(spec?.parent).toEqual({ taskId: first })
      expect(spec?.prompt).toContain("failed")
      expect(spec?.acceptance).toEqual(GATES)

      yield* scene.workerDone(fix, CODEX)
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CLAUDE })
      yield* scene.pass
      // Both worker runs are on record, so the reviewer excludes both executors.
      const reviewSpec = scene.fake.store.get(yield* scene.currentOf(id))?.spec
      expect(new Set(reviewSpec?.review?.excludeExecutors)).toEqual(new Set([CLAUDE, CODEX]))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a blocker from the reviewer sends a fix and the second review can accept", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), {
        executor: CODEX,
        result: "[BLOCKER] the endpoint has no test",
      })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("fix")
      const fix = yield* scene.currentOf(id)
      expect(scene.fake.store.get(fix)?.spec.prompt).toContain("the endpoint has no test")

      yield* scene.workerDone(fix)
      yield* scene.pass
      yield* scene.ci("success")
      yield* scene.pass
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CLAUDE })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("review")
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merged")
      expect(mergeCalls(scene).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a second ci failure blocks the task and warns the project stream", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      yield* scene.ci("failure")
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      yield* scene.ci("timed_out")
      yield* scene.pass

      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(yield* scene.phaseOf(id)).toBe("settled")
      const warnings = yield* errorsOf(scene)
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.payload).toMatchObject({ where: "factory.cycle", tag: "Blocked" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a second blocker from the reviewer blocks the task", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), {
        executor: CODEX,
        result: "[MAJOR] wrong status code",
      })
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      yield* scene.ci("success")
      yield* scene.pass
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CLAUDE })
      yield* scene.pass
      yield* scene.fake.finish(yield* scene.currentOf(id), {
        executor: CODEX,
        result: "[BLOCKER] still wrong",
      })
      yield* scene.pass

      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect((yield* errorsOf(scene)).length).toBe(1)
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failing end-to-end run earns the worker a fix", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* toE2e(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { kind: "failed", state: "failed" })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("fix")
      expect(yield* scene.stateOf(id)).toBe("in_progress")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("with no end-to-end commands the reviewer follows the green ci", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ e2e: [] })
      const id = yield* scene.addIssue()
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("review")
      const spec = scene.fake.store.get(yield* scene.currentOf(id))?.spec
      expect(spec?.botId).toBe(scene.bots.reviewer.id)
    }).pipe(Effect.provide(TestLayer)),
  )
})
