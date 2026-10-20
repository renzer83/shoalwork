import { Effect, Schema } from "effect"
import { Budget } from "./budget.js"
import { ModelTier } from "./enums.js"
import { SchemaViolation } from "./errors.js"
import { BotId, PlanId, StepId, TaskId } from "./ids.js"

export const Step = Schema.Struct({
  id: StepId,
  title: Schema.String,
  prompt: Schema.String,
  dependsOn: Schema.Array(StepId),
  acceptance: Schema.Array(Schema.String),
  budget: Budget,
  tier: ModelTier,
  parallelizable: Schema.Boolean,
  assignedBot: Schema.optional(BotId),
})
export type Step = typeof Step.Type

export const Plan = Schema.Struct({
  id: PlanId,
  taskId: TaskId,
  steps: Schema.Array(Step),
})
export type Plan = typeof Plan.Type

const fail = (issue: string): Effect.Effect<never, SchemaViolation> =>
  Effect.fail(new SchemaViolation({ where: "Plan.steps", issue }))

// `!(x >= 0)` also catches NaN, which `x < 0` lets through; Number.isFinite rules out Infinity.
const hasNegativeBudget = (budget: Budget): boolean =>
  !(budget.tokens >= 0) || !(budget.seconds >= 0) || !(budget.usd >= 0) || !Number.isFinite(budget.usd)

// Kahn's algorithm, layered. Steps keep plan order inside each level.
// Unknown or cyclic dependencies are never placed, so callers must validate first.
const layers = (plan: Plan): StepId[][] => {
  const pending = new Map<StepId, Set<StepId>>()
  for (const step of plan.steps) pending.set(step.id, new Set(step.dependsOn))

  const levels: StepId[][] = []
  while (pending.size > 0) {
    const ready: StepId[] = []
    for (const [id, deps] of pending) if (deps.size === 0) ready.push(id)
    if (ready.length === 0) break
    levels.push(ready)
    for (const id of ready) pending.delete(id)
    for (const deps of pending.values()) for (const id of ready) deps.delete(id)
  }
  return levels
}

export const validatePlan = (plan: Plan): Effect.Effect<Plan, SchemaViolation> => {
  const ids = new Set<string>()
  for (const step of plan.steps) {
    if (ids.has(step.id)) return fail(`duplicate step id: ${step.id}`)
    ids.add(step.id)
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) return fail(`step ${step.id} depends on unknown step ${dep}`)
    }
  }
  for (const step of plan.steps) {
    if (hasNegativeBudget(step.budget)) return fail(`step ${step.id} has a negative budget`)
  }
  const placed = layers(plan).reduce((count, level) => count + level.length, 0)
  if (placed !== plan.steps.length) return fail("plan has cyclic step dependencies")
  return Effect.succeed(plan)
}

// Parallelizable levels: every step in level N depends only on steps in levels < N.
export const topoOrder = (plan: Plan): StepId[][] => layers(plan)
