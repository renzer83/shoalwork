import { it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { MERGE_WAIT_MS } from "../src/cycle-text.js"
import { CODEX, errorsOf, makeScene, mergeCalls, type Scene, TestLayer, toReview } from "./cycle-support.js"

describe("the merge by policy", () => {
  it.effect("asks a person when the policy asks, and merges once after the approval", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "ask" })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merge_wait")
      expect(scene.approvals.records.size).toBe(1)
      yield* scene.pass
      expect(mergeCalls(scene).length).toBe(0)
      expect(scene.approvals.records.size).toBe(1)

      scene.approvals.decide("approved")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merged")
      expect(mergeCalls(scene).length).toBe(1)
      yield* scene.pass
      expect(mergeCalls(scene).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("asks a person when the project does not auto-merge, even if the policy allows", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ autoMerge: false, policy: "allow" })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merge_wait")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks the task when the approval is denied", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "ask" })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      scene.approvals.decide("denied")
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("never merges when the policy denies", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "deny" })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("never merges without a policy (fail-closed)", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "none" })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks an asked merge when there is no approval flow", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "ask", withApprovals: false })
      const id = yield* scene.addIssue()
      yield* toReview(scene, id)
      yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
    }).pipe(Effect.provide(TestLayer)),
  )
})

// The reviewer accepted: the cycle is at the merge.
const accepted = (scene: Scene, id: string) =>
  Effect.gen(function* () {
    yield* toReview(scene, id)
    yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CODEX, result: "NONE" })
  })

describe("who the merge policy is asked as", () => {
  it.effect(
    "asks as the worker that opened the pull request, so a reviewer that may not merge does not stop it",
    () =>
      Effect.gen(function* () {
        const scene = yield* makeScene({ policy: "allow", reviewerPolicy: "deny" })
        const id = yield* scene.addIssue()
        yield* accepted(scene, id)
        yield* scene.pass
        expect(yield* scene.phaseOf(id)).toBe("merged")
        expect(mergeCalls(scene).length).toBe(1)
        expect(scene.policyCalls).toEqual([scene.bots.worker.id])
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks when the worker's policy denies, whatever the reviewer's says", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "deny", reviewerPolicy: "allow" })
      const id = yield* scene.addIssue()
      yield* accepted(scene, id)
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("files the approval request on the worker's Bot", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "ask" })
      const id = yield* scene.addIssue()
      yield* accepted(scene, id)
      yield* scene.pass
      const [entry] = Array.from(scene.approvals.records.values())
      expect(entry?.record.botId).toBe(scene.bots.worker.id)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("the merge that does not happen", () => {
  it.effect("never merges an approved request whose pull request number is gone", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ policy: "ask" })
      const id = yield* scene.addIssue()
      yield* accepted(scene, id)
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merge_wait")
      yield* scene.sql`UPDATE project_tasks SET pr_number = NULL WHERE id = ${id}`
      scene.approvals.decide("approved")
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(mergeCalls(scene).length).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks a pull request closed without a merge", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* accepted(scene, id)
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("merged")
      scene.pr.state = "CLOSED"
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect((yield* errorsOf(scene)).length).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("waits for an auto-merge that is still pending, then blocks it past the limit", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* accepted(scene, id)
      yield* scene.pass
      yield* TestClock.adjust(MERGE_WAIT_MS - 120_000)
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("merging")

      yield* TestClock.adjust(180_000)
      yield* scene.pass
      expect(yield* scene.stateOf(id)).toBe("blocked")
      expect(yield* scene.phaseOf(id)).toBe("settled")
    }).pipe(Effect.provide(TestLayer)),
  )
})
