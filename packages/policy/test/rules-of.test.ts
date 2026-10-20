import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Policy } from "../src/index.js"
import { BOT, DEFAULT_YAML, policyWith } from "./support.js"

const CHILD = `extends: default\nrules:\n  - { bot: "*", tool: "Bash(pnpm test *)", effect: allow }\n`

describe("Policy.rulesOf", () => {
  it.effect("gives the rules of the Bot's named policy, inherited rules included", () =>
    Effect.gen(function* () {
      const rules = yield* (yield* Policy).rulesOf(BOT)
      expect(rules.map((rule) => rule.tool)).toContain("Bash(pnpm test *)")
      expect(rules.map((rule) => rule.tool)).toContain("Read(.env*)")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML, dev: CHILD }, () => "dev"))),
  )

  it.effect("gives no rules for a policy name that does not exist", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Policy).rulesOf(BOT)).toEqual([])
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML }, () => "missing"))),
  )

  it.effect("gives no rules when the policy name cannot be read", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Policy).rulesOf(BOT)).toEqual([])
    }).pipe(
      Effect.provide(
        policyWith({ default: DEFAULT_YAML }, () => {
          throw new Error("bot lookup failed")
        }),
      ),
    ),
  )
})
