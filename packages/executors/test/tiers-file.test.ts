import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { ConfigError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { loadTierConfig } from "../src/tiers.js"

// Repo file: test/ -> executors/ -> packages/ -> shoalwork/config/model-tiers.yaml
const REAL_CONFIG = fileURLToPath(new URL("../../../config/model-tiers.yaml", import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/tiers/${name}`, import.meta.url))

describe("loadTierConfig", () => {
  it.effect("decodes the real config/model-tiers.yaml of the repo", () =>
    Effect.gen(function* () {
      const config = yield* loadTierConfig(REAL_CONFIG)
      expect(config.model_tiers.heavy).toEqual({
        executor: "claude-code",
        model: "claude-opus-5-5",
        effort: "high",
        alternatives: ["codex"],
      })
      expect(config.model_tiers.chat.executor).toBe("claude-code@chat")
      expect(config.routing.app_op).toBe("light")
    }),
  )

  it.effect("a missing file is a ConfigError naming the path", () =>
    Effect.gen(function* () {
      const missing = fixture("does-not-exist.yaml")
      const error = yield* Effect.flip(loadTierConfig(missing))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(missing)
    }),
  )

  it.effect("a YAML syntax error is a ConfigError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadTierConfig(fixture("invalid-syntax.yaml")))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.message).toContain("invalid YAML")
    }),
  )

  it.effect("a YAML document with the wrong shape is a ConfigError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadTierConfig(fixture("invalid-shape.yaml")))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(fixture("invalid-shape.yaml"))
    }),
  )
})
