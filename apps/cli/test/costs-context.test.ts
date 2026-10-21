import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { UsageError } from "../src/args.js"
import {
  type ContextCostsBody,
  contextQuery,
  goalVerdict,
  parseGoal,
  renderContextCosts,
} from "../src/commands/costs.js"

const body = (
  tokensInAvgPct: number | null,
  okRatePct: number | null,
  note: string | null = null,
): ContextCostsBody => ({
  by: "task",
  window: { since: "2026-10-08T00:00:00.000Z", until: "2026-10-15T00:00:00.000Z" },
  rows: [
    {
      key: "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      n: 2,
      tokensInAvg: 550,
      tokensInP90: 900,
      contextTokensAvg: 600,
      okRate: 0.5,
    },
  ],
  totals: { n: 10, tokensInAvg: 550, okRate: 0.8 },
  unpaired: 1,
  compare: null,
  delta: { tokensInAvgPct, okRatePct },
  note,
})

describe("parseGoal", () => {
  it("accepts a fraction in (0, 1] and rejects anything else", async () => {
    expect(await Effect.runPromise(parseGoal("0.40"))).toBe(0.4)
    for (const raw of ["0", "1.5", "abc", "-0.2"]) {
      const exit = await Effect.runPromiseExit(parseGoal(raw))
      expect(exit._tag).toBe("Failure")
    }
    expect(new UsageError({ message: "x" })._tag).toBe("UsageError")
  })
})

describe("goalVerdict (exit 0 / 1 of costs context --goal)", () => {
  it("is met when tokensIn falls by at least the goal and okRate does not fall", () => {
    expect(goalVerdict(body(-45, 0), 0.4).met).toBe(true)
    expect(goalVerdict(body(-40, 0), 0.4).met).toBe(true)
  })

  it("is not met when the fall is smaller than the goal", () => {
    expect(goalVerdict(body(-39.9, 0), 0.4).met).toBe(false)
  })

  it("is not met when okRate fell, even with a big token fall", () => {
    const verdict = goalVerdict(body(-60, -2), 0.4)
    expect(verdict.met).toBe(false)
    expect(verdict.reason).toContain("okRate fell")
  })

  it("fails closed without a comparison, and says why", () => {
    expect(goalVerdict(body(null, null, 'no baselines row for project "x"'), 0.4)).toEqual({
      met: false,
      reason: 'no baselines row for project "x"',
    })
    expect(goalVerdict(body(-50, null), 0.4)).toEqual({ met: false, reason: "okRate has no comparison" })
  })
})

describe("renderContextCosts", () => {
  it("prints the table, the delta, the unpaired count and the verdict", () => {
    const text = renderContextCosts(body(-45, 0), false, { met: true, reason: "tokensIn -45%" })
    expect(text).toContain("tokensInP90")
    expect(text).toContain("tokensIn per execution vs compare: -45.0%")
    expect(text).toContain("unpaired executions (no executor.started in the window): 1")
    expect(text).toContain("goal: MET (tokensIn -45%)")
  })

  it("omits the goal line without --goal", () => {
    expect(renderContextCosts(body(-45, 0), false, undefined)).not.toContain("goal:")
  })
})

describe("contextQuery", () => {
  it("sends by, since and compareWith, and rejects level-less by values", async () => {
    const params = await Effect.runPromise(
      contextQuery({ by: "level", since: "14d", compare: "baseline:faturium" }),
    )
    expect(params.get("by")).toBe("level")
    expect(params.get("compareWith")).toBe("baseline:faturium")
    const exit = await Effect.runPromiseExit(contextQuery({ by: "tier" }))
    expect(exit._tag).toBe("Failure")
  })
})
