import { it } from "@effect/vitest"
import { ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { makeOpenAICompat } from "../../src/openai-compat/index.js"
import { collect, fakeTank, policyOf, task } from "./harness.js"

// Needs a running OpenAI-compatible endpoint, by default Ollama. LIVE=1 OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=<model>
const LIVE = process.env.LIVE === "1"

describe.skipIf(!LIVE)("openai-compat live (ollama)", () => {
  it.live(
    "answers pong",
    () =>
      Effect.gen(function* () {
        const base = process.env.OLLAMA_URL ?? "http://localhost:11434"
        const executor = makeOpenAICompat({
          id: Schema.decodeUnknownSync(ExecutorId)("ollama"),
          baseUrl: `${base}/v1`,
          defaultModel: process.env.OLLAMA_MODEL ?? "qwen3:8b",
          supportsTools: false,
          policy: policyOf("deny").policy,
        })
        const { shape } = fakeTank()
        const events = yield* collect(
          executor,
          task({ prompt: "Reply with the single word: pong", maxTurns: 1 }),
          shape,
        )
        const last = events.at(-1)
        expect(last?.kind).toBe("done")
        expect(last?.kind === "done" ? last.result.toLowerCase() : "").toContain("pong")
      }),
    120_000,
  )
})
