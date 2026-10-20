import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { Plan, topoOrder, validatePlan } from "../src/plan.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const PLAN_ID = "plan_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"
const TASK_ID = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const A = "step_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
const B = "step_3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a"
const C = "step_4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b"
const D = "step_5f6a7b8c-9d0e-4f1a-8b2c-4d5e6f7a8b9c"
const UNKNOWN = "step_00000000-0000-4000-8000-000000000000"

const DEFAULT_BUDGET = { tokens: 1000, seconds: 60, usd: 0.01 }

const step = (id: string, dependsOn: ReadonlyArray<string>, budget = DEFAULT_BUDGET) => ({
  id,
  title: id,
  prompt: "do the thing",
  dependsOn,
  acceptance: [],
  budget,
  tier: "light",
  parallelizable: false,
})

// Decodes a raw plan so the test exercises the same typed value the core receives.
const decodePlan = (steps: ReadonlyArray<ReturnType<typeof step>>) =>
  Schema.decodeUnknownSync(Plan)({ id: PLAN_ID, taskId: TASK_ID, steps })

describe("plan", () => {
  it("Plan round-trips the fixture", () => {
    const raw = fixture("plan.json")
    expect(Schema.encodeSync(Plan)(Schema.decodeUnknownSync(Plan)(raw))).toEqual(raw)
  })

  it.effect("validatePlan accepts the fixture plan", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(Plan)(fixture("plan.json"))
      const validated = yield* validatePlan(plan)
      expect(validated).toBe(plan)
    }),
  )

  it.effect("rejects plan with cyclic dependencies", () =>
    Effect.gen(function* () {
      const plan = decodePlan([step(A, [B]), step(B, [A])])
      const error = yield* Effect.flip(validatePlan(plan))
      expect(error._tag).toBe("SchemaViolation")
      expect(error.issue).toContain("cyclic")
    }),
  )

  it.effect("rejects a step that depends on itself", () =>
    Effect.gen(function* () {
      const plan = decodePlan([step(A, [A])])
      const error = yield* Effect.flip(validatePlan(plan))
      expect(error._tag).toBe("SchemaViolation")
    }),
  )

  it.effect("rejects a dependency on a step that is not in the plan", () =>
    Effect.gen(function* () {
      const plan = decodePlan([step(A, []), step(B, [UNKNOWN])])
      const error = yield* Effect.flip(validatePlan(plan))
      expect(error._tag).toBe("SchemaViolation")
      expect(error.issue).toContain("unknown step")
    }),
  )

  it.effect("rejects duplicate step ids", () =>
    Effect.gen(function* () {
      const plan = decodePlan([step(A, []), step(A, [])])
      const error = yield* Effect.flip(validatePlan(plan))
      expect(error._tag).toBe("SchemaViolation")
      expect(error.issue).toContain("duplicate")
    }),
  )

  it.effect("rejects a step with a negative budget", () =>
    Effect.gen(function* () {
      // Budget itself rejects a negative limit when decoded, so the plan is built in memory to reach validatePlan.
      const base = decodePlan([step(A, []), step(B, [A])])
      const plan = {
        ...base,
        steps: base.steps.map((s) =>
          s.id === B ? { ...s, budget: { tokens: -1, seconds: 60, usd: 0.01 } } : s,
        ),
      }
      const error = yield* Effect.flip(validatePlan(plan))
      expect(error._tag).toBe("SchemaViolation")
      expect(error.issue).toContain("negative budget")
    }),
  )

  it.effect("rejects a step with a NaN or infinite usd budget", () =>
    Effect.gen(function* () {
      const base = decodePlan([step(A, []), step(B, [A])])
      for (const usd of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const plan = {
          ...base,
          steps: base.steps.map((s) => (s.id === B ? { ...s, budget: { tokens: 1, seconds: 60, usd } } : s)),
        }
        const error = yield* Effect.flip(validatePlan(plan))
        expect(error._tag).toBe("SchemaViolation")
      }
    }),
  )

  it("topoOrder groups the fixture into parallelizable levels", () => {
    const plan = Schema.decodeUnknownSync(Plan)(fixture("plan.json"))
    const [first, second, third, fourth] = plan.steps.map((s) => s.id)
    expect(topoOrder(plan)).toEqual([[first, second], [third], [fourth]])
  })

  it("topoOrder puts every step with no dependencies in the first level", () => {
    const plan = decodePlan([step(A, []), step(B, []), step(C, []), step(D, [])])
    expect(topoOrder(plan)).toEqual([[A, B, C, D]])
  })
})
