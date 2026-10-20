import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { newTaskId, type Step } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { checkDraft } from "../src/plan/check.js"
import { jsonObjects, readDraft } from "../src/plan/reply.js"
import { LIMITS, MAX_STEPS, PlanDraft } from "../src/plan/schema-json.js"
import { fixture, planJson, setup, stepJson, TestLayer } from "./plan-support.js"
import { NEW_BOT } from "./support.js"

const accepts = (step: Record<string, unknown>): boolean =>
  Schema.decodeUnknownOption(PlanDraft)({ steps: [step] })._tag === "Some"

describe("PlanDraft size limits", () => {
  it("accepts the limits exactly and rejects one past each", () => {
    expect(accepts(stepJson("a", { title: "t".repeat(LIMITS.title) }))).toBe(true)
    expect(accepts(stepJson("a", { title: "t".repeat(LIMITS.title + 1) }))).toBe(false)
    expect(accepts(stepJson("a", { prompt: "p".repeat(LIMITS.prompt) }))).toBe(true)
    expect(accepts(stepJson("a", { prompt: "p".repeat(LIMITS.prompt + 1) }))).toBe(false)
    expect(accepts(stepJson("a", { acceptance: ["c".repeat(LIMITS.criterion)] }))).toBe(true)
    expect(accepts(stepJson("a", { acceptance: ["c".repeat(LIMITS.criterion + 1)] }))).toBe(false)
    expect(accepts(stepJson("a", { acceptance: Array.from({ length: LIMITS.criteria }, () => "c") }))).toBe(
      true,
    )
    expect(
      accepts(stepJson("a", { acceptance: Array.from({ length: LIMITS.criteria + 1 }, () => "c") })),
    ).toBe(false)
    expect(accepts(stepJson("a", { dependsOn: Array.from({ length: MAX_STEPS }, (_, i) => `d${i}`) }))).toBe(
      true,
    )
    expect(
      accepts(stepJson("a", { dependsOn: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `d${i}`) })),
    ).toBe(false)
  })

  it.effect("sends an oversize field back to the model as our sentence, without echoing it", () =>
    Effect.gen(function* () {
      const huge = "SECRET-INJECTION ".repeat(40)
      const t = yield* setup([planJson([stepJson("a", { title: huge })]), fixture("valid")])
      expect((yield* t.planner.plan(t.task)).kind).toBe("planned")
      expect(t.script.prompts[1]).toContain(`title up to ${LIMITS.title} characters`)
      expect(t.script.prompts[1]).toContain("previous answer was rejected")
      expect(t.script.prompts[1]).not.toContain("SECRET-INJECTION")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rejects a reply over the size limit before parsing it, and blocks after two", () =>
    Effect.gen(function* () {
      const big = `${fixture("valid")}${" ".repeat(LIMITS.reply)}`
      const t = yield* setup([big, big])
      expect((yield* t.planner.plan(t.task)).kind).toBe("blocked")
      expect(t.script.prompts).toHaveLength(2)
      expect(t.script.prompts[1]).toContain(`longer than ${LIMITS.reply} characters`)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("reading the plan out of a reply", () => {
  const good = JSON.stringify({ steps: [stepJson("a")] })

  it("takes the second object when the first one is not a plan", () => {
    const reply = `Context: {"note": "first"}\nPlan: ${good}`
    expect(jsonObjects(reply)[0]).toBe('{"note": "first"}')
    const draft = Effect.runSync(readDraft(reply))
    expect(draft.steps.map((step) => step.ref)).toEqual(["a"])
  })

  it("takes the first plan when there are two", () => {
    const other = JSON.stringify({ steps: [stepJson("b")] })
    expect(Effect.runSync(readDraft(`${good} and ${other}`)).steps[0]?.ref).toBe("a")
  })

  it("ignores braces in the prose around the plan and inside its strings", () => {
    const tricky = JSON.stringify({ steps: [stepJson("a", { title: "use { and } and \\ in text" })] })
    const reply = `I will use {braces} and an open { here.\n\`\`\`json\n${tricky}\n\`\`\`\nDone } thanks`
    expect(Effect.runSync(readDraft(reply)).steps[0]?.title).toBe("use { and } and \\ in text")
  })

  it("fails with our sentence when no object is a plan", () => {
    const failure = Effect.runSync(Effect.flip(readDraft("nothing {here} or { there")))
    expect(failure).toHaveLength(1)
    expect(failure[0]).toContain("no JSON plan")
  })

  it("answers a flood of open braces with the no-plan sentence", () => {
    const failure = Effect.runSync(Effect.flip(readDraft("{".repeat(150_000))))
    expect(failure[0]).toContain("no JSON plan")
  })
})

const BOT = { id: "bot_00000000-0000-4000-8000-000000000001", name: "worker-bot" } as never
const TASK = newTaskId()

const draftOf = (budgets: ReadonlyArray<{ tokens: number; seconds: number; usd: number }>) =>
  Schema.decodeUnknownSync(PlanDraft)({
    steps: budgets.map((budget, index) => stepJson(`s${index}`, { budget })),
  })

const micros = (steps: ReadonlyArray<Step>): number =>
  steps.reduce((total, step) => total + Math.floor(step.budget.usd * 1e6 + 1e-6), 0)

describe("fitting the step budgets to the task budget", () => {
  const limit = { tokens: 100_000, seconds: 60, usd: 1 }
  const run = (budgets: ReadonlyArray<{ tokens: number; seconds: number; usd: number }>, over = limit) =>
    Effect.runSync(Effect.result(checkDraft(draftOf(budgets), { taskId: TASK, budget: over, bots: [BOT] })))

  it("keeps the sum inside every dimension for steps that do not divide evenly, never raising a step", () => {
    const asked = [
      { tokens: 70_001, seconds: 33, usd: 0.333333 },
      { tokens: 50_003, seconds: 29, usd: 0.4 },
      { tokens: 30_007, seconds: 17, usd: 0.7 },
      { tokens: 12_345, seconds: 11, usd: 0.123457 },
    ]
    const result = run(asked)
    if (result._tag !== "Success") throw new Error("expected a plan")
    const steps = result.success.plan.steps
    expect(result.success.warnings).toHaveLength(1)
    expect(steps.reduce((total, step) => total + step.budget.tokens, 0)).toBeLessThanOrEqual(limit.tokens)
    expect(steps.reduce((total, step) => total + step.budget.seconds, 0)).toBeLessThanOrEqual(limit.seconds)
    expect(micros(steps)).toBeLessThanOrEqual(1_000_000)
    steps.forEach((step, index) => {
      expect(step.budget.tokens).toBeLessThanOrEqual(asked[index]?.tokens ?? 0)
      expect(step.budget.seconds).toBeLessThanOrEqual(asked[index]?.seconds ?? 0)
      expect(step.budget.usd).toBeLessThanOrEqual(asked[index]?.usd ?? 0)
    })
  })

  it("holds for generated plans: inside the limits, no step above what it asked, or a problem to retry", () => {
    let seed = 12345
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % max
    }
    for (let round = 0; round < 300; round++) {
      const count = 1 + next(MAX_STEPS)
      const asked = Array.from({ length: count }, () => ({
        tokens: 1 + next(90_000),
        seconds: 1 + next(120),
        usd: (1 + next(900_000)) / 1e6,
      }))
      const cap = { tokens: 1 + next(150_000), seconds: 1 + next(100), usd: (1 + next(1_500_000)) / 1e6 }
      const result = run(asked, cap)
      if (result._tag === "Failure") {
        expect(result.failure[0]).toContain("fitting the task budget leaves step")
        continue
      }
      const steps = result.success.plan.steps
      expect(steps.reduce((total, step) => total + step.budget.tokens, 0)).toBeLessThanOrEqual(cap.tokens)
      expect(steps.reduce((total, step) => total + step.budget.seconds, 0)).toBeLessThanOrEqual(cap.seconds)
      expect(micros(steps)).toBeLessThanOrEqual(Math.floor(cap.usd * 1e6 + 1e-6))
      steps.forEach((step, index) => {
        expect(step.budget.tokens).toBeLessThanOrEqual(asked[index]?.tokens ?? 0)
        expect(step.budget.seconds).toBeLessThanOrEqual(asked[index]?.seconds ?? 0)
        expect(step.budget.usd).toBeLessThanOrEqual(asked[index]?.usd ?? 0)
      })
    }
  })

  it("is a problem when fitting leaves a step with nothing, and not when the task limit itself is zero", () => {
    const twelve = Array.from({ length: 12 }, () => ({ tokens: 1000, seconds: 5, usd: 0.01 }))
    const starved = run(twelve, { tokens: 5, seconds: 60, usd: 1 })
    expect(starved._tag).toBe("Failure")
    if (starved._tag === "Failure") expect(starved.failure[0]).toContain("no tokens")

    const nothing = run(twelve, { tokens: 0, seconds: 60, usd: 1 })
    expect(nothing._tag).toBe("Success")
  })

  it.effect("sends the starved plan back once and accepts the corrected one", () =>
    Effect.gen(function* () {
      const twelve = Array.from({ length: 12 }, (_, i) =>
        stepJson(`s${i}`, { budget: { tokens: 100_000, seconds: 5, usd: 0.01 } }),
      )
      const small = planJson([stepJson("a", { budget: { tokens: 5, seconds: 5, usd: 0.01 } })])
      const t = yield* setup([planJson(twelve), small], { budget: { tokens: 6, seconds: 60, usd: 1 } })
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("planned")
      expect(t.script.prompts[1]).toContain("leaves step")
      expect(t.script.prompts[1]).toContain("no tokens")
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("a Bot really called new", () => {
  it.effect("is not an owner: the literal new always means a new Bot, and the Bot is not offered", () =>
    Effect.gen(function* () {
      const t = yield* setup([planJson([stepJson("a", { assignedBot: "new" })])])
      const registry = yield* BotRegistry
      yield* registry.upsert({ ...NEW_BOT, name: "new" }, "test")
      const outcome = yield* t.planner.plan(t.task)
      if (outcome.kind !== "planned") throw new Error("expected a plan")
      expect(outcome.plan.steps[0]?.assignedBot).toBeUndefined()
      expect(t.script.prompts[0]).toContain("- worker-bot:")
      expect(t.script.prompts[0]).not.toContain("- new:")
    }).pipe(Effect.provide(TestLayer)),
  )
})
