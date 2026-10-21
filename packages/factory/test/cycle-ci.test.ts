import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { BRANCH, CODEX, makeScene, type Scene, TestLayer } from "./cycle-support.js"

// A task whose worker opened the pull request: the cycle waits for the checks.
const toCi = (scene: Scene) =>
  Effect.gen(function* () {
    const id = yield* scene.addIssue()
    yield* scene.pass
    yield* scene.workerDone(yield* scene.currentOf(id))
    yield* scene.pass
    expect(yield* scene.phaseOf(id)).toBe("ci")
    return id
  })

const checksCalls = (scene: Scene) => scene.gh.calls.filter((call) => call.method === "prChecks").length

const fixesOf = (scene: Scene, id: string) =>
  Effect.gen(function* () {
    const rows = yield* scene.sql`SELECT fixes FROM project_cycles WHERE task_id = ${id}`
    return rows[0]?.fixes
  })

describe("the ci gate", () => {
  it.effect("a cancelled run is not a failure: it spends no fix and asks nothing", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* scene.ci("cancelled")
      yield* scene.pass
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      expect(yield* fixesOf(scene, id)).toBe(0)
      expect(checksCalls(scene)).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a late failure of the previous push during the fix does not knock the new push down", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* scene.ci("failure")
      yield* scene.pass
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("fix")
      expect(yield* fixesOf(scene, id)).toBe(1)

      // The old run reports late, while the checks of the new push are still running.
      yield* scene.ci("failure", BRANCH, "pending")
      yield* scene.pass
      yield* scene.workerDone(yield* scene.currentOf(id), CODEX)
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      expect(yield* scene.stateOf(id)).toBe("in_review")
      expect(yield* fixesOf(scene, id)).toBe(1)

      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a green workflow does not advance while another check is still running", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* scene.ci("success", BRANCH, "pending")
      yield* scene.pass
      expect(checksCalls(scene)).toBe(1)
      expect(yield* scene.phaseOf(id)).toBe("ci")
      expect(scene.fake.store.size).toBe(1)

      // Asked once: the spent hint is not asked again until the next event.
      yield* scene.pass
      expect(checksCalls(scene)).toBe(1)

      yield* scene.ci("success")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a green event over failing checks sends the fix", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* scene.ci("success", BRANCH, "fail")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("fix")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a result seen before the pull request number is known leaves the hint for the next pass", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* toCi(scene)
      yield* scene.ci("success")
      const real = scene.pr.checks
      scene.pr.checks = "pending"
      yield* scene.sql`UPDATE project_tasks SET pr_number = NULL WHERE id = ${id}`
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      yield* scene.sql`UPDATE project_tasks SET pr_number = 7 WHERE id = ${id}`
      scene.pr.checks = real
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("the ci cursor", () => {
  const cursorOf = (scene: Scene) =>
    Effect.gen(function* () {
      const rows = yield* scene.sql`SELECT position FROM project_cycle_cursors WHERE project = 'demo'`
      return rows[0]?.position
    })

  it.effect("holds a result whose branch is not recorded yet and reads it again once it is", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const id = yield* scene.addIssue()
      yield* scene.pass
      const early = yield* scene.ci("success")
      yield* scene.pass
      // The worker still delivers and no task owns the branch: the result stays unread.
      expect(yield* cursorOf(scene)).toBeUndefined()

      yield* scene.workerDone(yield* scene.currentOf(id))
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("ci")
      yield* scene.pass
      expect(yield* scene.phaseOf(id)).toBe("e2e")
      expect(yield* cursorOf(scene)).toBe(early.position)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops a result nobody waits for", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene()
      const stranger = yield* scene.ci("success", "someone/else")
      yield* scene.pass
      expect(yield* cursorOf(scene)).toBe(stranger.position)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("one broken task", () => {
  it.effect("does not stop the other tasks nor the start of the next ready one", () =>
    Effect.gen(function* () {
      const scene = yield* makeScene({ maxInProgress: 3 })
      const ids: Array<string> = []
      for (let n = 0; n < 4; n += 1) ids.push(yield* scene.addIssue())
      yield* scene.pass
      const [broken, lost, fine, waiting] = ids as [string, string, string, string]
      const brokenTask = yield* scene.currentOf(broken)
      const lostTask = yield* scene.currentOf(lost)
      yield* scene.workerDone(brokenTask)
      yield* scene.workerDone(yield* scene.currentOf(fine))
      // One Lead task blows up, another is gone.
      scene.fake.flags.dieOn = brokenTask
      scene.fake.store.delete(lostTask)

      yield* scene.pass
      expect(yield* scene.phaseOf(fine)).toBe("ci")
      expect(yield* scene.stateOf(fine)).toBe("in_review")
      expect(yield* scene.stateOf(lost)).toBe("blocked")
      expect(yield* scene.phaseOf(broken)).toBe("work")
      // `fine` freed a slot and `lost` too: the waiting task started in the same pass.
      expect(yield* scene.stateOf(waiting)).toBe("in_progress")
    }).pipe(Effect.provide(TestLayer)),
  )
})
