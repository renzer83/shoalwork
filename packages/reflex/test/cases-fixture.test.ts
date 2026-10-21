import { describe, expect, it } from "vitest"
import { compileRules, scoreAll } from "../src/rules.js"
import { config, loadFixture } from "./support.js"

// Not live: the fixture the Python tests read must be what the TypeScript rules answer, case by case.
const fixture = loadFixture()
const rules = compileRules(config)

describe("services/reflex/tests/cases.json matches the TypeScript rules", () => {
  it("was exported from the config the TypeScript rules read", () => {
    expect(fixture.config).toEqual(config)
  })

  it("has at least twenty cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20)
  })

  for (const item of fixture.cases) {
    it(`recomputes ${JSON.stringify(item.name)} to the recorded answers`, () => {
      const scores = scoreAll(item.facts, rules)
      const actual = {
        intent: scores.intent,
        complexity: scores.complexity,
        owner: scores.owner,
        executor: scores.executor,
        parallelizable: scores.parallelizable,
        risk: scores.risk,
        needs_approval: scores.needs_approval,
        language: scores.language,
      }
      expect(actual).toEqual(item.expected)
    })
  }
})
