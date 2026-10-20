import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { MAX_STEPS } from "../src/plan/check.js"
import { fixture, planJson, setup, stepJson, TestLayer } from "./plan-support.js"

describe("Planner.plan rules", () => {
  it.effect.each([
    ["a step without acceptance", "no-acceptance", "acceptance"],
    ["a Bot that is not listed", "unknown-bot", "not in the list"],
  ])("rejects %s and asks again", ([, name, reason]) =>
    Effect.gen(function* () {
      const t = yield* setup([fixture(name ?? ""), fixture("valid")])
      expect((yield* t.planner.plan(t.task)).kind).toBe("planned")
      expect(t.script.prompts[1]).toContain(reason ?? "")
      // The wrong Bot name from the model is not echoed back.
      expect(t.script.prompts[1]).not.toContain("ghost-bot")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rejects an unknown dependency, a duplicate ref and more than the step limit", () =>
    Effect.gen(function* () {
      const unknown = yield* setup([
        planJson([stepJson("a", { dependsOn: ["zzz"] })]),
        planJson([stepJson("a")]),
      ])
      yield* unknown.planner.plan(unknown.task)
      expect(unknown.script.prompts[1]).toContain("depends on unknown step zzz")

      const dup = yield* setup([planJson([stepJson("a"), stepJson("a")]), planJson([stepJson("a")])])
      yield* dup.planner.plan(dup.task)
      expect(dup.script.prompts[1]).toContain("used more than once")

      const many = Array.from({ length: MAX_STEPS + 1 }, (_, index) => stepJson(`s${index}`))
      const big = yield* setup([planJson(many), planJson([stepJson("a")])])
      yield* big.planner.plan(big.task)
      expect(big.script.prompts[1]).toContain(`the limit is ${MAX_STEPS}`)

      const empty = yield* setup([planJson([]), planJson([stepJson("a")])])
      yield* empty.planner.plan(empty.task)
      expect(empty.script.prompts[1]).toContain("no steps")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("accepts exactly the step limit", () =>
    Effect.gen(function* () {
      const steps = Array.from({ length: MAX_STEPS }, (_, index) => stepJson(`s${index}`))
      const t = yield* setup([planJson(steps)])
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("planned")
      expect(t.script.prompts).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("does nothing for a task that does not meet the trigger", () =>
    Effect.gen(function* () {
      const t = yield* setup([fixture("valid")], { kind: "research", acceptance: ["done"] })
      expect(yield* t.planner.plan(t.task)).toEqual({ kind: "skipped", reason: "trigger" })
      expect(t.script.prompts).toHaveLength(0)
      expect((yield* t.tasks.get(t.task.id)).state).toBe("received")
      expect(yield* t.events()).toHaveLength(0)
      // The same task planned once the Reflex rates it complex.
      expect((yield* t.planner.plan(t.task, { complexity: 3 })).kind).toBe("planned")
    }).pipe(Effect.provide(TestLayer)),
  )
})
