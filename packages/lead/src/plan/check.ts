import {
  type Bot,
  type Budget,
  newPlanId,
  newStepId,
  type Plan,
  type PlanId,
  type Step,
  type StepId,
  type TaskId,
  validatePlan,
} from "@shoalwork/contracts"
import { Effect } from "effect"
import { MAX_STEPS, type PlanDraft } from "./schema-json.js"

// Assigned Bot value meaning "no listed Bot fits": the step is left without an owner.
export const NEW_BOT = "new"
// Dollars are summed and split as whole micro-dollars, so a sum of parts never passes its limit by rounding.
const MICRO = 1_000_000

export { MAX_STEPS }

export interface CheckInput {
  readonly taskId: TaskId
  readonly budget: Budget
  // Bots a step may be assigned to (name -> id).
  readonly bots: ReadonlyArray<Pick<Bot, "id" | "name">>
}

export interface Checked {
  readonly plan: Plan
  readonly warnings: ReadonlyArray<string>
}

// Rounded down (the epsilon only absorbs float noise like 0.29 * 1e6): a step never counts for more than it asked.
const micros = (usd: number): number => Math.floor(usd * MICRO + 1e-6)

interface Totals {
  readonly tokens: number
  readonly seconds: number
  readonly micros: number
}

const totalOf = (steps: ReadonlyArray<Step>): Totals => ({
  tokens: steps.reduce((total, step) => total + step.budget.tokens, 0),
  seconds: steps.reduce((total, step) => total + step.budget.seconds, 0),
  micros: steps.reduce((total, step) => total + micros(step.budget.usd), 0),
})

// Each dimension that is over the task's budget is scaled down by limit/total (rounding down, so no step ever gets
// more than it asked for); the others stay as they are. A step left with nothing in a scaled dimension is a problem
// for the model to solve (fewer steps, smaller budgets), listed in `empty`.
const fitToBudget = (steps: ReadonlyArray<Step>, limit: Budget) => {
  const total = totalOf(steps)
  const cap = micros(limit.usd)
  const tokens = total.tokens > limit.tokens ? limit.tokens / total.tokens : 1
  const seconds = total.seconds > limit.seconds ? limit.seconds / total.seconds : 1
  const usd = total.micros > cap ? cap / total.micros : 1
  if (tokens === 1 && seconds === 1 && usd === 1) {
    return { steps, scaled: false, empty: [] as ReadonlyArray<string> }
  }
  const fitted = steps.map(
    (step): Step => ({
      ...step,
      budget: {
        tokens: Math.floor(step.budget.tokens * tokens),
        seconds: Math.floor(step.budget.seconds * seconds),
        usd: usd < 1 ? Math.floor(micros(step.budget.usd) * usd) / MICRO : step.budget.usd,
      },
    }),
  )
  const empty = fitted.flatMap((step, index) => {
    const dimensions = [
      ...(tokens < 1 && limit.tokens > 0 && step.budget.tokens === 0 ? ["tokens"] : []),
      ...(seconds < 1 && limit.seconds > 0 && step.budget.seconds === 0 ? ["seconds"] : []),
      ...(usd < 1 && cap > 0 && micros(step.budget.usd) === 0 ? ["usd"] : []),
    ]
    return dimensions.length === 0
      ? []
      : [
          `fitting the task budget leaves step ${index + 1} with no ${dimensions.join(" and ")}; use fewer steps`,
        ]
  })
  return { steps: fitted, scaled: true, empty }
}

// What is wrong with the draft that the Schema cannot say, as short sentences of ours (never the model's text).
const draftProblems = (draft: PlanDraft, bots: CheckInput["bots"]): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (draft.steps.length === 0) {
    problems.push("the plan has no steps")
  }
  if (draft.steps.length > MAX_STEPS) {
    problems.push(`the plan has ${draft.steps.length} steps; the limit is ${MAX_STEPS}`)
  }
  const refs = new Set<string>()
  for (const step of draft.steps) {
    if (refs.has(step.ref)) {
      problems.push(`step ref ${step.ref} is used more than once`)
    }
    refs.add(step.ref)
  }
  const names = new Set(bots.map((bot) => bot.name))
  for (const step of draft.steps) {
    if (step.title.trim() === "" || step.prompt.trim() === "") {
      problems.push(`step ${step.ref} needs a title and a prompt`)
    }
    if (step.acceptance.length === 0 || step.acceptance.some((item) => item.trim() === "")) {
      problems.push(`step ${step.ref} needs at least one non-empty acceptance criterion`)
    }
    for (const dep of step.dependsOn) {
      if (!refs.has(dep)) {
        problems.push(`step ${step.ref} depends on unknown step ${dep}`)
      }
    }
    if (step.assignedBot !== NEW_BOT && !names.has(step.assignedBot)) {
      problems.push(
        `step ${step.ref} is assigned to a Bot that is not in the list; use a listed name or "new"`,
      )
    }
  }
  return problems
}

const toPlan = (draft: PlanDraft, input: CheckInput, planId: PlanId): Plan => {
  const ids = new Map<string, StepId>(draft.steps.map((step) => [step.ref, newStepId()]))
  const botIds = new Map(input.bots.map((bot) => [bot.name, bot.id]))
  const steps = draft.steps.map((step): Step => {
    const botId = botIds.get(step.assignedBot)
    return {
      id: ids.get(step.ref) ?? newStepId(),
      title: step.title.trim(),
      prompt: step.prompt.trim(),
      dependsOn: step.dependsOn.flatMap((ref) => ids.get(ref) ?? []),
      acceptance: step.acceptance.map((item) => item.trim()),
      budget: step.budget,
      tier: step.tier,
      parallelizable: step.parallelizable,
      ...(botId === undefined ? {} : { assignedBot: botId }),
    }
  })
  return { id: planId, taskId: input.taskId, steps }
}

// A draft becomes a Plan only when every rule holds: the sentences of ours when it does not (to go back to the model
// once), else the Plan with the step budgets reduced to fit the task's.
export const checkDraft = (
  draft: PlanDraft,
  input: CheckInput,
): Effect.Effect<Checked, ReadonlyArray<string>> =>
  Effect.gen(function* () {
    // A Bot that is really called "new" is not an owner: the literal always means "a new Bot".
    const owners = { ...input, bots: input.bots.filter((bot) => bot.name !== NEW_BOT) }
    const problems = draftProblems(draft, owners.bots)
    if (problems.length > 0) {
      return yield* Effect.fail(problems)
    }
    const plan = yield* validatePlan(toPlan(draft, owners, newPlanId())).pipe(
      Effect.mapError((error) => [typeof error.issue === "string" ? error.issue : "the plan is not valid"]),
    )
    const fitted = fitToBudget(plan.steps, input.budget)
    if (fitted.empty.length > 0) {
      return yield* Effect.fail(fitted.empty)
    }
    return {
      plan: { ...plan, steps: fitted.steps },
      warnings: fitted.scaled
        ? ["the step budgets were above the task budget and were reduced proportionally"]
        : [],
    }
  })
