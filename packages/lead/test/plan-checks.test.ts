import { it } from "@effect/vitest"
import { type Bot, newBotId, newTaskId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { checkDraft } from "../src/plan/check.js"
import { buildPlanPrompt } from "../src/plan/prompt.js"
import { decodePlanDraft, LIMITS, type PlanDraft } from "../src/plan/schema-json.js"
import { REVIEW_ACCEPTANCE } from "../src/verify/review.js"

const dev: Pick<Bot, "id" | "name" | "role"> = { id: newBotId(), name: "dev", role: "developer" }
const budget = { tokens: 1200, seconds: 120, usd: 1.2 }
const draftStep = (over: Record<string, unknown> = {}) => ({
  ref: "a",
  title: "Build",
  prompt: "build it",
  dependsOn: [],
  acceptance: ["it builds"],
  checks: [],
  budget: { tokens: 100, seconds: 10, usd: 0.01 },
  tier: "heavy",
  parallelizable: false,
  assignedBot: "dev",
  ...over,
})
const input = { taskId: newTaskId(), budget, bots: [dev] }

const parse = (steps: ReadonlyArray<Record<string, unknown>>) => {
  const decoded = decodePlanDraft(JSON.stringify({ steps }))
  return decoded._tag === "Some" ? decoded.value : undefined
}

describe("plan checks", () => {
  it("a reply without a checks key means no commands", () => {
    const { checks: _omitted, ...bare } = draftStep()
    expect(parse([bare])?.steps[0]?.checks).toEqual([])
  })

  it("refuses more checks, more words or longer words than the limits", () => {
    const check = { argv: ["pnpm", "test"] }
    expect(parse([draftStep({ checks: Array.from({ length: LIMITS.checks }, () => check) })])).toBeDefined()
    expect(
      parse([draftStep({ checks: Array.from({ length: LIMITS.checks + 1 }, () => check) })]),
    ).toBeUndefined()
    expect(
      parse([draftStep({ checks: [{ argv: Array.from({ length: LIMITS.argv + 1 }, () => "x") }] })]),
    ).toBeUndefined()
    expect(parse([draftStep({ checks: [{ argv: ["x".repeat(LIMITS.arg + 1)] }] })])).toBeUndefined()
  })

  it.effect(
    "checks become the step's structured commands; the model's steps are work, the Lead's is the review",
    () =>
      Effect.gen(function* () {
        const draft: PlanDraft | undefined = parse([draftStep({ checks: [{ argv: ["pnpm", "test"] }] })])
        expect(draft).toBeDefined()
        if (draft === undefined) return
        const { plan } = yield* checkDraft(draft, { ...input, review: { prompt: "review it" } })
        expect(plan.steps.map((s) => s.kind)).toEqual(["work", "review"])
        expect(plan.steps[0]?.checks).toEqual([{ argv: ["pnpm", "test"] }])
        expect(plan.steps[1]).toMatchObject({ checks: [], acceptance: [REVIEW_ACCEPTANCE] })
      }),
  )

  it.effect("a step may have only checks, but not nothing at all", () =>
    Effect.gen(function* () {
      const onlyChecks = parse([draftStep({ acceptance: [], checks: [{ argv: ["pnpm", "lint"] }] })])
      const nothing = parse([draftStep({ acceptance: [], checks: [] })])
      if (onlyChecks === undefined || nothing === undefined) return expect.unreachable()
      yield* checkDraft(onlyChecks, input)
      const problems = yield* checkDraft(nothing, input).pipe(Effect.flip)
      expect(problems).toContain("step a needs at least one non-empty acceptance criterion")
    }),
  )

  it.effect("a check without a command is sent back to the model", () =>
    Effect.gen(function* () {
      const empty = parse([draftStep({ checks: [{ argv: [" "] }] })])
      if (empty === undefined) return expect.unreachable()
      const problems = yield* checkDraft(empty, input).pipe(Effect.flip)
      expect(problems).toContain("step a has a check without a command (argv[0] is empty)")
    }),
  )

  it("the prompt describes the structured checks and their limits, not the old '$ ' convention", () => {
    const prompt = buildPlanPrompt({
      task: { title: "Fix", prompt: "fix it", kind: "code", acceptance: [], budget },
      bots: [],
      executors: ["claude-code"],
    })
    expect(prompt).toContain(`up to ${LIMITS.checks} checks per step`)
    expect(prompt).toContain('"argv"')
    expect(prompt).not.toContain('"$ "')
  })
})

describe("a code plan verifies every step", () => {
  it.effect("a work step without a check is sent back to the model with our reason", () =>
    Effect.gen(function* () {
      const bare = parse([draftStep({ checks: [] })])
      if (bare === undefined) return expect.unreachable()
      const problems = yield* checkDraft(bare, { ...input, review: { prompt: "review it" } }).pipe(
        Effect.flip,
      )
      expect(problems).toContain("step a needs at least one check command (a code plan verifies every step)")
    }),
  )

  it.effect("other plans may have steps without checks", () =>
    Effect.gen(function* () {
      const bare = parse([draftStep({ checks: [] })])
      if (bare === undefined) return expect.unreachable()
      const { plan } = yield* checkDraft(bare, input)
      expect(plan.steps[0]?.checks).toEqual([])
    }),
  )
})
