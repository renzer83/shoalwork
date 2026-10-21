import { it } from "@effect/vitest"
import { ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { type BriefingInput, buildBriefing } from "../../src/context/briefing.js"
import { makeTokenizer } from "../../src/context/tokenizer.js"
import { DEFAULT_TOKENIZER_CONFIG } from "../../src/context/tokenizer-config.js"
import { config, deps, planner, scratch } from "./briefing-support.js"
import { bot, spec } from "./fixtures.js"

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")

const input = (executor?: ExecutorId): BriefingInput => ({
  spec,
  bot,
  ctx: scratch,
  plan: planner.plan(spec, { complexity: 3 }),
  config,
  executor,
})

describe("buildBriefing token source", () => {
  it.effect("reports approx without a Tokenizer", () =>
    Effect.gen(function* () {
      const briefing = yield* buildBriefing(deps(), input(CLAUDE))
      expect(briefing.tokenSource).toBe("approx")
    }),
  )

  it.effect(
    "counts with the Tokenizer: approx on the first assembly, mixed once its cache holds the blocks",
    () =>
      Effect.gen(function* () {
        const tokenizer = makeTokenizer({ config: DEFAULT_TOKENIZER_CONFIG })
        const first = yield* buildBriefing(deps({ tokenizer }), input(CLAUDE))
        const second = yield* buildBriefing(deps({ tokenizer }), input(CLAUDE))
        expect(first.tokenSource).toBe("approx")
        expect(second.tokenSource).toBe("mixed")
        expect(second.text).toBe(first.text)
        expect(second.used).toBe(first.used)
      }),
  )
})
