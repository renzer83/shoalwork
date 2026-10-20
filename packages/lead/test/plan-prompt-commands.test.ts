import { describe, expect, it } from "vitest"
import { buildPlanPrompt } from "../src/plan/prompt.js"

const base = {
  task: {
    title: "Fix",
    prompt: "fix it",
    kind: "code" as const,
    acceptance: [],
    budget: { tokens: 1200, seconds: 120, usd: 1.2 },
  },
  bots: [],
  executors: ["claude-code"],
}

describe("buildPlanPrompt command convention and review reserve", () => {
  it("declares the structured checks and that only test, lint, typecheck and build commands are accepted", () => {
    const prompt = buildPlanPrompt(base)
    expect(prompt).toContain('"checks" lists the commands the Lead runs')
    expect(prompt).not.toContain('starts with "$ "')
    expect(prompt).toContain('Only "test", "lint", "typecheck" and "build"')
    expect(prompt).toContain("EVERY step has at least one command")
  })

  it("tells a code plan its steps have one slot less and a reserved review budget", () => {
    const prompt = buildPlanPrompt(base)
    expect(prompt).toContain("never more than 11, the Lead adds one review step last")
    expect(prompt).toContain("The steps together must fit in 1100 tokens, 110 seconds, 1.1 USD")
  })

  it("leaves a research plan with the full step limit and no reserve", () => {
    const prompt = buildPlanPrompt({ ...base, task: { ...base.task, kind: "research" } })
    expect(prompt).toContain("never more than 12)")
    expect(prompt).not.toContain("reserved for the review step")
  })
})
