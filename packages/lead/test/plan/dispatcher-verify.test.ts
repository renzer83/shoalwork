import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { type StepId, streamIds } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import {
  checked,
  DispatchLayer,
  fakeIntegration,
  okVerdict,
  setupDispatch,
  step,
  verified,
} from "./dispatch-support.js"

const branchOf = (id: StepId) => `bot/dev/${id}`

describe("Dispatcher verification of work steps", () => {
  it.effect(
    "a step that fails verification gets one retry that says what failed, and is verified again",
    () =>
      Effect.gen(function* () {
        const a = checked("a")
        const integration = yield* fakeIntegration()
        const { dispatcher, plan, assignments, specs, verifications } = yield* setupDispatch([a], {
          integration,
          run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
          verify: (_input, nth) =>
            nth === 1 ? verified("failed", ["an acceptance command exited with 1"]) : verified("ok"),
        })

        const result = yield* dispatcher.run(plan, assignments)

        expect(result.state).toBe("done")
        expect(result.steps[0]).toMatchObject({ status: "done", runs: 2 })
        expect(specs).toHaveLength(2)
        expect(specs[1]?.prompt).toContain("did not pass verification")
        expect(specs[1]?.prompt).toContain("an acceptance command exited with 1")
        // The retry continues from the branch the failed run pushed.
        expect(specs[1]?.repo?.base).toBe(branchOf(a.id))
        expect(verifications).toHaveLength(2)
        // What is verified is the branch the step pushed; only the verified run is merged.
        expect(verifications[0]?.base).toBe(branchOf(a.id))
        expect(integration.merges).toEqual(["a"])
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a step that fails verification twice fails, is not merged and opens no PR", () =>
    Effect.gen(function* () {
      const a = checked("a")
      const b = checked("b", [a.id])
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a, b], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        verify: () => verified("failed", ["an acceptance command exited with 1"]),
      })

      const result = yield* dispatcher.run(plan, assignments)

      expect(result.state).toBe("failed")
      expect(result.steps[0]).toMatchObject({ status: "failed", runs: 2 })
      expect(result.steps[0]?.reason).toContain("verification failed")
      expect(result.steps[1]).toMatchObject({ status: "blocked", reason: `depends on ${a.id}` })
      expect(specs).toHaveLength(2)
      expect(integration.merges).toEqual([])
      expect(integration.prs).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("needs_human blocks the step with the reason and runs nothing more", () =>
    Effect.gen(function* () {
      const a = checked("a")
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        verify: () => verified("needs_human", ["an acceptance command was refused by policy and not run"]),
      })

      const result = yield* dispatcher.run(plan, assignments)

      expect(result.state).toBe("failed")
      expect(result.steps[0]).toMatchObject({ status: "blocked", runs: 1 })
      expect(result.steps[0]?.reason).toContain("needs_human")
      expect(result.steps[0]?.reason).toContain("refused by policy")
      expect(specs).toHaveLength(1)
      expect(integration.merges).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a step that already used its retry on a conflict fails verification without another run", () =>
    Effect.gen(function* () {
      const a = checked("a")
      const integration = yield* fakeIntegration((_branch, nth) =>
        nth === 1
          ? { _tag: "Conflict", files: ["x.ts"] }
          : { _tag: "Merged", serialized: false, overlap: [] },
      )
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        // The first run passes; the run that follows the merge conflict does not.
        verify: (_input, nth) => (nth === 1 ? verified("ok") : verified("failed", ["tests fail"])),
      })

      const result = yield* dispatcher.run(plan, assignments)

      expect(result.steps[0]).toMatchObject({ status: "failed", runs: 2 })
      expect(specs).toHaveLength(2)
      expect(integration.merges).toEqual(["a"])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a step without checks is not verified at all and merges as before", () =>
    Effect.gen(function* () {
      const a = step("a")
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, verifications, specs } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        verify: () => verified("failed", ["never asked"]),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.state).toBe("done")
      expect(verifications).toEqual([])
      expect(specs[0]?.holdWorktree).toBeUndefined()
      expect(integration.merges).toEqual(["a"])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a refused check blocks the step for a person and spends no retry", () =>
    Effect.gen(function* () {
      const a = checked("a")
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        verify: () =>
          verified("needs_human", ["the acceptance command `pnpm test` was refused by policy and not run"]),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.steps[0]).toMatchObject({ status: "blocked", runs: 1 })
      expect(result.steps[0]?.reason).toContain("refused by policy")
      expect(specs).toHaveLength(1)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("the verification and its reason are recorded on the step's task", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const a = checked("a")
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, tasks, specs } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
        verify: () => verified("failed", ["the acceptance command `pnpm test` exited with 1"]),
      })
      yield* dispatcher.run(plan, assignments)
      const first = specs[0]
      if (first === undefined) return expect.unreachable()
      yield* tasks.get(first.id)
      const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(first.id))))
      const recorded = events.find((event) => event.type === "step.verified")
      expect(recorded?.payload).toMatchObject({
        stepId: a.id,
        final: "failed",
        notes: ["the acceptance command `pnpm test` exited with 1"],
      })
    }).pipe(Effect.provide(DispatchLayer)),
  )
})
