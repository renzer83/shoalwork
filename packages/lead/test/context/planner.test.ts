import { TaskSpec } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DEFAULT_CONTEXT_CONFIG } from "../../src/context/config.js"
import { fallbackDecision, makeContextPlanner, planLevel } from "../../src/context/planner.js"
import { spec } from "./fixtures.js"

const withSpec = (patch: Record<string, unknown>) =>
  Schema.decodeUnknownSync(TaskSpec)({ ...Schema.encodeSync(TaskSpec)(spec), ...patch })

const repo = { url: "https://example.invalid/acme/demo.git", base: "main" }

describe("planLevel", () => {
  it("gives chat and system tasks no context at all", () => {
    expect(planLevel(withSpec({ kind: "chat" }), { complexity: 4 })).toBe("none")
    expect(planLevel(withSpec({ kind: "system" }), { complexity: 4 })).toBe("none")
  })

  it("gives code and research with a repo top3 up to complexity 1 and full above", () => {
    for (const kind of ["code", "research"]) {
      const task = withSpec({ kind, repo })
      expect(planLevel(task, { complexity: 0 })).toBe("top3")
      expect(planLevel(task, { complexity: 1 })).toBe("top3")
      expect(planLevel(task, { complexity: 2 })).toBe("full")
      expect(planLevel(task, { complexity: 4 })).toBe("full")
    }
  })

  it("gives code without a repo top3 whatever the complexity", () => {
    expect(planLevel(withSpec({ kind: "code" }), { complexity: 4 })).toBe("top3")
  })

  it("gives app_op and routine top3", () => {
    expect(planLevel(withSpec({ kind: "app_op" }), { complexity: 4 })).toBe("top3")
    expect(planLevel(withSpec({ kind: "routine" }), { complexity: 0 })).toBe("top3")
  })
})

describe("ContextPlanner", () => {
  const planner = makeContextPlanner(DEFAULT_CONTEXT_CONFIG)

  it("asks for nothing at level none and for the configured counts otherwise", () => {
    expect(planner.plan(withSpec({ kind: "chat", tier: "chat" }), { complexity: 0 })).toEqual({
      level: "none",
      memoryK: 0,
      codeK: 0,
      budgetTokens: 2000,
    })
    expect(planner.plan(withSpec({ kind: "code", repo, tier: "heavy" }), { complexity: 3 })).toEqual({
      level: "full",
      memoryK: 8,
      codeK: 6,
      budgetTokens: 24000,
    })
    expect(planner.plan(withSpec({ kind: "routine", tier: "light" }), { complexity: 0 })).toEqual({
      level: "top3",
      memoryK: 3,
      codeK: 0,
      budgetTokens: 8000,
    })
  })

  it("stands the tier in for the complexity when there is no decision", () => {
    expect(fallbackDecision("heavy").complexity).toBe(2)
    expect(fallbackDecision("light").complexity).toBe(1)
  })
})
