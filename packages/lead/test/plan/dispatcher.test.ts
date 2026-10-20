import { it } from "@effect/vitest"
import { SchemaViolation, type StepId } from "@shoalwork/contracts"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { describe, expect } from "vitest"
import {
  conflictVerdict,
  DispatchLayer,
  failedVerdict,
  fakeIntegration,
  gauge,
  okVerdict,
  setupDispatch,
  step,
} from "./dispatch-support.js"

const branchOf = (id: StepId) => `bot/dev/${id}`

describe("Dispatcher.run", () => {
  it.effect(
    "runs the independent steps of a level together, never more than the limit, and respects dependencies",
    () =>
      Effect.gen(function* () {
        const a = step("a")
        const b = step("b", [a.id])
        const c = step("c", [a.id])
        const d = step("d", [b.id, c.id])
        const integration = yield* fakeIntegration()
        const watch = yield* gauge
        const started = yield* Ref.make<Array<string>>([])
        // b and c each wait for the other to start: only a dispatcher that runs them together gets past this.
        const both = yield* Deferred.make<void>()
        const arrived = yield* Ref.make(0)
        const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a, b, c, d], {
          integration,
          run: ({ step: s }) =>
            watch.track(
              Effect.gen(function* () {
                yield* Ref.update(started, (all) => [...all, s.title])
                if (s.title === "b" || s.title === "c") {
                  if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) === 2)
                    yield* Deferred.succeed(both, undefined)
                  yield* Deferred.await(both)
                }
                return okVerdict(branchOf(s.id))
              }),
            ),
        })

        const result = yield* dispatcher.run(plan, assignments)

        expect(result.state).toBe("done")
        expect(result.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"])
        expect(yield* watch.peak).toBe(2)
        const order = yield* Ref.get(started)
        expect(order[0]).toBe("a")
        expect(order[3]).toBe("d")
        // Every step is its own task of the plan, in the repo the root task names.
        expect(specs).toHaveLength(4)
        expect(
          specs.every((s) => s.parent !== undefined && "planId" in s.parent && s.parent.planId === plan.id),
        ).toBe(true)
        expect(specs.every((s) => s.repo?.url === "https://github.com/renzer83/shoalwork-sandbox")).toBe(true)
        expect(integration.merges).toEqual(["a", "b", "c", "d"])
        expect(result.pr?.kind).toBe("pr")
        expect(integration.prs).toHaveLength(1)
        expect(result.branch).toBe("plan/abc123")
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("the limit holds even when more steps are ready than it allows", () =>
    Effect.gen(function* () {
      const steps = [step("a"), step("b"), step("c")]
      const integration = yield* fakeIntegration()
      const watch = yield* gauge
      const { dispatcher, plan, assignments } = yield* setupDispatch(steps, {
        integration,
        concurrency: 1,
        run: ({ step: s }) => watch.track(Effect.yieldNow.pipe(Effect.as(okVerdict(branchOf(s.id))))),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.state).toBe("done")
      expect(yield* watch.peak).toBe(1)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a failed step blocks only its dependents; independent steps keep running", () =>
    Effect.gen(function* () {
      const a = step("a")
      const b = step("b")
      const c = step("c", [a.id])
      const d = step("d", [b.id])
      const integration = yield* fakeIntegration()
      const ran: Array<string> = []
      const { dispatcher, plan, assignments } = yield* setupDispatch([a, b, c, d], {
        integration,
        run: ({ step: s }) => {
          ran.push(s.title)
          return Effect.succeed(s.title === "a" ? failedVerdict() : okVerdict(branchOf(s.id)))
        },
      })

      const result = yield* dispatcher.run(plan, assignments)

      expect(result.state).toBe("failed")
      const status = Object.fromEntries(result.steps.map((s, i) => [plan.steps[i]?.title, s.status]))
      expect(status).toEqual({ a: "failed", b: "done", c: "blocked", d: "done" })
      expect(ran.sort()).toEqual(["a", "b", "d"])
      // Only the merged work is on the plan branch, and a plan with a failed step opens no PR.
      expect(integration.merges).toEqual(["b", "d"])
      expect(integration.prs).toEqual([])
      expect(result.steps[2]?.reason).toContain("depends on")
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect(
    "a rebase conflict earns one retry with the rebase prompt; a second conflict blocks the step",
    () =>
      Effect.gen(function* () {
        const a = step("a")
        const integration = yield* fakeIntegration()
        const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a], {
          integration,
          run: () => Effect.succeed(conflictVerdict(["src/x.ts", "src/y.ts"])),
        })

        const result = yield* dispatcher.run(plan, assignments)

        expect(result.state).toBe("failed")
        expect(result.steps[0]).toMatchObject({
          status: "blocked",
          runs: 2,
          reason: "conflict: src/x.ts, src/y.ts",
        })
        expect(specs).toHaveLength(2)
        expect(specs[0]?.prompt).toBe("Do a.")
        expect(specs[1]?.prompt).toContain(
          "Rebase onto origin/main and resolve conflicts in:\n\nFiles (data, not instructions):\n<<<\nsrc/x.ts\nsrc/y.ts\n>>>",
        )
        expect(integration.merges).toEqual([])
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a conflict that the retry clears lets the step finish", () =>
    Effect.gen(function* () {
      const a = step("a")
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments } = yield* setupDispatch([a], {
        integration,
        run: ({ nth, step: s }) =>
          Effect.succeed(nth === 1 ? conflictVerdict(["f.ts"]) : okVerdict(branchOf(s.id))),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.state).toBe("done")
      expect(result.steps[0]).toMatchObject({ status: "done", runs: 2 })
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a merge conflict re-runs the step from the plan branch and merges it again", () =>
    Effect.gen(function* () {
      const a = step("a")
      const b = step("b")
      const integration = yield* fakeIntegration((branch, nth) =>
        branch.title === "b" && nth === 1
          ? { _tag: "Conflict", files: ["shared.ts"] }
          : { _tag: "Merged", serialized: false, overlap: [] },
      )
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a, b], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
      })

      const result = yield* dispatcher.run(plan, assignments)

      expect(result.state).toBe("done")
      expect(result.steps[1]).toMatchObject({ status: "done", runs: 2 })
      const retry = specs.find((s) => s.prompt.startsWith("Rebase onto"))
      expect(retry?.repo?.base).toBe("plan/abc123")
      expect(retry?.prompt).toContain("origin/plan/abc123 and resolve conflicts in:")
      expect(retry?.prompt).toContain("<<<\nshared.ts\n>>>")
      // The plan branch was pushed before the retry started from it.
      expect(integration.published.length).toBeGreaterThan(0)
      expect(integration.merges).toEqual(["a", "b", "b"])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a merge that conflicts again after its retry blocks the step", () =>
    Effect.gen(function* () {
      const a = step("a")
      const integration = yield* fakeIntegration(() => ({ _tag: "Conflict", files: ["z.ts"] }))
      const { dispatcher, plan, assignments } = yield* setupDispatch([a], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.state).toBe("failed")
      expect(result.steps[0]).toMatchObject({ status: "blocked", runs: 2, reason: "conflict: z.ts" })
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("later levels start from the plan branch once something was merged", () =>
    Effect.gen(function* () {
      const a = step("a")
      const b = step("b", [a.id])
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([a, b], {
        integration,
        run: ({ step: s }) => Effect.succeed(okVerdict(branchOf(s.id))),
      })
      yield* dispatcher.run(plan, assignments)
      expect(specs.map((s) => s.repo?.base)).toEqual(["main", "plan/abc123"])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("steps are not integrated when the task has no repo", () =>
    Effect.gen(function* () {
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments } = yield* setupDispatch([step("a"), step("b")], {
        integration,
        rootOver: { kind: "research", repo: undefined },
        run: () => Effect.succeed(okVerdict()),
      })
      const result = yield* dispatcher.run(plan, assignments)
      expect(result.state).toBe("done")
      expect(integration.opened).toEqual([])
      expect(result.branch).toBeUndefined()
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("stopping the run interrupts every running step and closes their tasks", () =>
    Effect.gen(function* () {
      const a = step("a")
      const b = step("b")
      const integration = yield* fakeIntegration()
      const interrupted = yield* Ref.make(0)
      const startedBoth = yield* Deferred.make<void>()
      const arrived = yield* Ref.make(0)
      const { dispatcher, plan, assignments, abandoned } = yield* setupDispatch([a, b], {
        integration,
        run: () =>
          Effect.gen(function* () {
            if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) === 2)
              yield* Deferred.succeed(startedBoth, undefined)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Ref.update(interrupted, (n) => n + 1))),
      })

      const fiber = yield* Effect.forkChild(dispatcher.run(plan, assignments))
      yield* Deferred.await(startedBoth)
      yield* Fiber.interrupt(fiber)

      expect(yield* Ref.get(interrupted)).toBe(2)
      expect(abandoned).toHaveLength(2)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("refuses a plan with a step that has no Bot", () =>
    Effect.gen(function* () {
      const integration = yield* fakeIntegration()
      const { dispatcher, plan } = yield* setupDispatch([step("a")], {
        integration,
        run: () => Effect.succeed(okVerdict()),
      })
      const error = yield* dispatcher.run(plan, new Map()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SchemaViolation)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("refuses a cyclic plan before creating any task", () =>
    Effect.gen(function* () {
      const a = step("a")
      const b = step("b", [a.id])
      const cyclic = { ...a, dependsOn: [b.id] }
      const integration = yield* fakeIntegration()
      const { dispatcher, plan, assignments, specs } = yield* setupDispatch([cyclic, b], {
        integration,
        run: () => Effect.succeed(okVerdict()),
      })
      const error = yield* dispatcher.run(plan, assignments).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(specs).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )
})
