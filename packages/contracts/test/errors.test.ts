import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { BudgetExceeded, ConfigError, NotFound, PolicyDenied } from "../src/errors.js"

const LIMIT = { tokens: 100, seconds: 60, usd: 1 }
const USED = { tokens: 150, seconds: 10, usd: 0.5 }

describe("errors", () => {
  it("BudgetExceeded carries its _tag and fields", () => {
    const err = new BudgetExceeded({ scope: "task", limit: LIMIT, used: USED })
    expect(err._tag).toBe("BudgetExceeded")
    expect(err.scope).toBe("task")
    expect(err.limit).toEqual(LIMIT)
    expect(err.used).toEqual(USED)
  })

  it("each error class sets _tag to its own name", () => {
    expect(new NotFound({ entity: "bot", id: "x" })._tag).toBe("NotFound")
    expect(new PolicyDenied({ botId: "b", tool: "shell" })._tag).toBe("PolicyDenied")
    expect(new ConfigError({ key: "DATABASE_PATH", message: "missing" })._tag).toBe("ConfigError")
  })

  it.effect("Effect.catchTag recovers a BudgetExceeded failure", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.fail(new BudgetExceeded({ scope: "bot", limit: LIMIT, used: USED })).pipe(
        Effect.catchTag("BudgetExceeded", (e) => Effect.succeed(e.scope)),
      )
      expect(scope).toBe("bot")
    }),
  )
})
