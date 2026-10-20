import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { ConfigError, ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { resolveRepoPath } from "../src/config.js"
import { codexModelsFrom, DEFAULT_TIERS, loadModelTiers } from "../src/model-tiers.js"

const SHIPPED = resolveRepoPath("config/model-tiers.yaml")
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")

describe("loadModelTiers", () => {
  it.effect("the shipped config/model-tiers.yaml loads and equals the built-in defaults", () =>
    Effect.gen(function* () {
      const config = yield* loadModelTiers(SHIPPED)
      expect(config).toEqual(DEFAULT_TIERS)
    }),
  )

  it.effect("a missing file gives the built-in defaults instead of failing the boot", () =>
    Effect.gen(function* () {
      const config = yield* loadModelTiers(fixture("does-not-exist.yaml"))
      expect(config).toEqual(DEFAULT_TIERS)
    }),
  )

  it.effect("an invalid file is a ConfigError naming the file, so the core does not boot on it", () =>
    Effect.gen(function* () {
      const path = fixture("model-tiers-invalid.yaml")
      const error = yield* Effect.flip(loadModelTiers(path))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(path)
    }),
  )
})

describe("codexModelsFrom", () => {
  it("is undefined without a codex entry and without CODEX_MODEL: codex keeps its own default", () => {
    expect(codexModelsFrom(DEFAULT_TIERS, undefined)).toBeUndefined()
  })

  it("uses CODEX_MODEL for every tier when the yaml names no codex tier", () => {
    expect(codexModelsFrom(DEFAULT_TIERS, "gpt-fallback")).toEqual({
      chat: "gpt-fallback",
      decision: "gpt-fallback",
      light: "gpt-fallback",
      heavy: "gpt-fallback",
    })
  })

  it("takes the model of a tier whose yaml entry names codex, and CODEX_MODEL for the others", () => {
    const edited = {
      ...DEFAULT_TIERS,
      model_tiers: {
        ...DEFAULT_TIERS.model_tiers,
        heavy: { executor: CODEX, model: "gpt-heavy" },
      },
    }
    expect(codexModelsFrom(edited, "gpt-fallback")).toEqual({
      chat: "gpt-fallback",
      decision: "gpt-fallback",
      light: "gpt-fallback",
      heavy: "gpt-heavy",
    })
    expect(codexModelsFrom(edited, undefined)).toEqual({ heavy: "gpt-heavy" })
  })
})
