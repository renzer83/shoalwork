import {
  type Bot,
  type Budget,
  newPlanId,
  newStepId,
  type Plan,
  type Step,
  type StepId,
  type TaskId,
  validatePlan,
} from "@shoalwork/contracts"
import { Effect } from "effect"
import { REVIEW_ACCEPTANCE } from "../verify/review.js"
import { MAX_STEPS, type PlanDraft } from "./schema-json.js"

// Assigned Bot value meaning "no listed Bot fits": the step is left without an owner.
export const NEW_BOT = "new"
// A Bot whose role mentions review owns the review step of a code plan, when one is listed.
const REVIEWER_ROLE = /\breview/i
// Dollars are summed and split as whole micro-dollars, so a sum of parts never passes its limit by rounding.
const MICRO = 1_000_000

export { MAX_STEPS }

export interface CheckInput {
  readonly taskId: TaskId
  readonly budget: Budget
  // Bots a step may be assigned to (name -> id), with their roles.
  readonly bots: ReadonlyArray<Pick<Bot, "id" | "name" | "role">>
  // Set for a code task: the plan gets a review step last, with this prompt. The review step counts toward MAX_STEPS,
  // and its budget is reserved from the task budget before the model's steps are fitted.
  readonly review?: { readonly prompt: string }
}

export interface Checked {
  readonly plan: Plan
  readonly warnings: ReadonlyArray<string>
}

// Rounded down (the epsilon only absorbs float noise like 0.29 * 1e6): a step never counts for more than it asked.
const micros = (usd: number): number => Math.floor(usd * MICRO + 1e-6)

// The review step of a code plan keeps one part of MAX_STEPS of the task budget, in every dimension.
export const reviewBudgetOf = (budget: Budget): Budget => ({
  tokens: Math.floor(budget.tokens / MAX_STEPS),
  seconds: Math.floor(budget.seconds / MAX_STEPS),
  usd: Math.floor(micros(budget.usd) / MAX_STEPS) / MICRO,
})

// What the model's steps may use together: the task budget less the review step's reserve.
export const stepsBudgetOf = (budget: Budget): Budget => {
  const reserve = reviewBudgetOf(budget)
  return {
    tokens: budget.tokens - reserve.tokens,
    seconds: budget.seconds - reserve.seconds,
    usd: (micros(budget.usd) - micros(reserve.usd)) / MICRO,
  }
}

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

// Each dimension that is over the limit is scaled down by limit/total (rounding down, so no step ever gets more than
// it asked for); the others stay as they are. A step left with nothing in a scaled dimension is a problem for the
// model to solve (fewer steps, smaller budgets), listed in `empty`.
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
// `reserved` counts the steps the Lead adds itself (the review step of a code plan).
const draftProblems = (
  draft: PlanDraft,
  bots: CheckInput["bots"],
  reserved: number,
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (draft.steps.length === 0) {
    problems.push("the plan has no steps")
  }
  if (draft.steps.length + reserved > MAX_STEPS) {
    problems.push(
      `the plan has ${draft.steps.length} steps; the limit is ${MAX_STEPS}${reserved > 0 ? ", the review step included" : ""}`,
    )
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
    if (
      (step.acceptance.length === 0 && step.checks.length === 0) ||
      step.acceptance.some((item) => item.trim() === "")
    ) {
      problems.push(`step ${step.ref} needs at least one non-empty acceptance criterion`)
    }
    if (reserved > 0 && step.checks.length === 0) {
      problems.push(`step ${step.ref} needs at least one check command (a code plan verifies every step)`)
    }
    if (step.checks.some((check) => (check.argv[0] ?? "").trim() === "")) {
      problems.push(`step ${step.ref} has a check without a command (argv[0] is empty)`)
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

const toSteps = (draft: PlanDraft, input: CheckInput): ReadonlyArray<Step> => {
  const ids = new Map<string, StepId>(draft.steps.map((step) => [step.ref, newStepId()]))
  const botIds = new Map(input.bots.map((bot) => [bot.name, bot.id]))
  return draft.steps.map((step): Step => {
    const botId = botIds.get(step.assignedBot)
    return {
      id: ids.get(step.ref) ?? newStepId(),
      title: step.title.trim(),
      prompt: step.prompt.trim(),
      dependsOn: step.dependsOn.flatMap((ref) => ids.get(ref) ?? []),
      acceptance: step.acceptance.map((item) => item.trim()),
      kind: "work",
      checks: step.checks.map((check) => ({ argv: check.argv })),
      budget: step.budget,
      tier: step.tier,
      parallelizable: step.parallelizable,
      ...(botId === undefined ? {} : { assignedBot: botId }),
    }
  })
}

// The review runs last, after every step it reviews, with the reserved budget. Its owner is the first listed Bot whose
// role is review, else a Pod auxiliary.
const reviewStep = (steps: ReadonlyArray<Step>, input: CheckInput): Step => {
  const reviewer = input.bots.find((bot) => REVIEWER_ROLE.test(bot.role))
  return {
    id: newStepId(),
    title: "Review",
    prompt: input.review?.prompt ?? "",
    dependsOn: steps.map((step) => step.id),
    acceptance: [REVIEW_ACCEPTANCE],
    kind: "review",
    checks: [],
    budget: reviewBudgetOf(input.budget),
    tier: "heavy",
    parallelizable: false,
    ...(reviewer === undefined ? {} : { assignedBot: reviewer.id }),
  }
}

// A draft becomes a Plan only when every rule holds: the sentences of ours when it does not (to go back to the model
// once), else the Plan with the model's step budgets fitted to the task's budget (less the review reserve, if any).
export const checkDraft = (
  draft: PlanDraft,
  input: CheckInput,
): Effect.Effect<Checked, ReadonlyArray<string>> =>
  Effect.gen(function* () {
    // A Bot that is really called "new" is not an owner: the literal always means "a new Bot".
    const owners = { ...input, bots: input.bots.filter((bot) => bot.name !== NEW_BOT) }
    const problems = draftProblems(draft, owners.bots, input.review === undefined ? 0 : 1)
    if (problems.length > 0) {
      return yield* Effect.fail(problems)
    }
    const modelSteps = toSteps(draft, owners)
    const modelPlan = yield* validatePlan({ id: newPlanId(), taskId: input.taskId, steps: modelSteps }).pipe(
      Effect.mapError((error) => [typeof error.issue === "string" ? error.issue : "the plan is not valid"]),
    )
    const reviewed = input.review !== undefined
    const fitted = fitToBudget(modelPlan.steps, reviewed ? stepsBudgetOf(input.budget) : input.budget)
    if (fitted.empty.length > 0) {
      return yield* Effect.fail(fitted.empty)
    }
    const steps = reviewed ? [...fitted.steps, reviewStep(fitted.steps, owners)] : fitted.steps
    const plan: Plan = yield* validatePlan({ ...modelPlan, steps }).pipe(
      Effect.mapError((error) => [typeof error.issue === "string" ? error.issue : "the plan is not valid"]),
    )
    return {
      plan,
      warnings: fitted.scaled
        ? [
            reviewed
              ? "the step budgets were above their share of the task budget (the rest is reserved for the review step) and were reduced proportionally"
              : "the step budgets were above the task budget and were reduced proportionally",
          ]
        : [],
    }
  })
