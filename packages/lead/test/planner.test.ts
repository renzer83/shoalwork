import { it } from "@effect/vitest"
import { Plan, topoOrder, validatePlan } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ChatFailure } from "../src/chat.js"
import { fixture, planJson, setup, stepJson, TestLayer } from "./plan-support.js"

describe("Planner.plan", () => {
  it.effect("stores a valid plan, moves the task planning -> ready and emits task.planned", () =>
    Effect.gen(function* () {
      const t = yield* setup([fixture("valid")])
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("planned")
      if (outcome.kind !== "planned") return
      expect(outcome.warnings).toEqual([])
      expect(t.script.prompts).toHaveLength(1)
      expect(t.script.notes).toEqual([])

      const plan = outcome.plan
      expect(plan.taskId).toBe(t.task.id)
      expect(plan.steps).toHaveLength(3)
      const [schema, link, endpoint] = plan.steps
      expect(endpoint?.dependsOn).toEqual([schema?.id, link?.id])
      // The Bot name became its id; "new" left the step without an owner.
      expect(schema?.assignedBot).toBe(t.bot.id)
      expect(link?.assignedBot).toBeUndefined()
      yield* validatePlan(plan)
      expect(topoOrder(plan).map((level) => level.length)).toEqual([2, 1])

      const [row] = yield* t.rows()
      expect(row?.id).toBe(plan.id)
      expect(row?.state).toBe("ready")
      const stored = Schema.decodeUnknownSync(Plan)(JSON.parse(row?.plan ?? "null"))
      expect(stored).toEqual(plan)

      expect((yield* t.tasks.get(t.task.id)).state).toBe("ready")
      const events = yield* t.events()
      expect(events.map((event) => event.type)).toEqual([
        "task.state_changed",
        "task.planned",
        "task.state_changed",
      ])
      expect(events[0]?.payload).toMatchObject({ from: "received", to: "planning" })
      expect(events[1]?.payload).toEqual({ taskId: t.task.id, planId: plan.id, stepCount: 3 })
      expect(events[2]?.payload).toMatchObject({ from: "planning", to: "ready" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("accepts a plan wrapped in a fence and a sentence", () =>
    Effect.gen(function* () {
      const t = yield* setup([`Here is the plan:\n\`\`\`json\n${fixture("valid")}\n\`\`\``])
      expect((yield* t.planner.plan(t.task)).kind).toBe("planned")
      expect(t.script.prompts).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("retries once with the reason when the plan has a dependency cycle", () =>
    Effect.gen(function* () {
      const t = yield* setup([fixture("cyclic"), fixture("valid")])
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("planned")
      expect(t.script.prompts).toHaveLength(2)
      expect(t.script.prompts[0]).not.toContain("previous answer was rejected")
      expect(t.script.prompts[1]).toContain("previous answer was rejected")
      expect(t.script.prompts[1]).toContain("cyclic")
      expect(yield* t.rows()).toHaveLength(1)
      expect((yield* t.tasks.get(t.task.id)).state).toBe("ready")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reduces step budgets proportionally when they pass the task budget, and says so", () =>
    Effect.gen(function* () {
      // Task budget: 100000 tokens, 60 s, 1 USD; the fixture asks for twice that.
      const t = yield* setup([fixture("over-budget")])
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("planned")
      if (outcome.kind !== "planned") return
      expect(outcome.warnings).toHaveLength(1)
      expect(outcome.plan.steps.map((step) => step.budget)).toEqual([
        { tokens: 50000, seconds: 30, usd: 0.5 },
        { tokens: 50000, seconds: 30, usd: 0.5 },
      ])
      expect(t.script.prompts).toHaveLength(1)
      expect(t.script.notes).toHaveLength(1)
      // What is stored is the reduced plan.
      const [row] = yield* t.rows()
      expect(Schema.decodeUnknownSync(Plan)(JSON.parse(row?.plan ?? "null"))).toEqual(outcome.plan)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("leaves budgets alone when only one dimension is over, scaling just that one", () =>
    Effect.gen(function* () {
      const steps = [
        stepJson("a", { budget: { tokens: 80000, seconds: 5, usd: 0.1 } }),
        stepJson("b", { budget: { tokens: 80000, seconds: 5, usd: 0.1 } }),
      ]
      const t = yield* setup([planJson(steps)])
      const outcome = yield* t.planner.plan(t.task)
      if (outcome.kind !== "planned") throw new Error("expected a plan")
      expect(outcome.plan.steps.map((step) => step.budget)).toEqual([
        { tokens: 50000, seconds: 5, usd: 0.1 },
        { tokens: 50000, seconds: 5, usd: 0.1 },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks the task after two invalid answers and tells the topic", () =>
    Effect.gen(function* () {
      const t = yield* setup([fixture("cyclic"), fixture("cyclic")])
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("blocked")
      if (outcome.kind !== "blocked") return
      expect(outcome.verdict.kind).toBe("blocked")
      expect(outcome.verdict.summary).toContain("cyclic")
      expect(t.script.prompts).toHaveLength(2)
      expect(yield* t.rows()).toHaveLength(0)
      expect(t.script.notes).toHaveLength(1)
      const record = yield* t.tasks.get(t.task.id)
      expect(record.state).toBe("failed")
      expect(record.verdict).toEqual(outcome.verdict)
      const events = yield* t.events()
      expect(events.map((event) => event.type)).toEqual(["task.state_changed", "task.state_changed"])
      expect(events[1]?.payload).toMatchObject({ from: "planning", to: "failed", reason: "invalid plan" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("blocks when the model gives no answer or no JSON", () =>
    Effect.gen(function* () {
      const none = yield* setup([new ChatFailure({ reason: "timeout", message: "over 60000 ms" })])
      const timedOut = yield* none.planner.plan(none.task)
      expect(timedOut.kind).toBe("blocked")
      expect(none.script.prompts).toHaveLength(2)

      const prose = yield* setup(["I cannot do that.", planJson([stepJson("a")])])
      expect((yield* prose.planner.plan(prose.task)).kind).toBe("planned")
      expect(prose.script.prompts[1]).toContain("no JSON plan")
    }).pipe(Effect.provide(TestLayer)),
  )
})
