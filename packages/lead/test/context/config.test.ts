import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  DEFAULT_CONTEXT_CONFIG,
  decodeContextConfigText,
  loadContextConfig,
} from "../../src/context/config.js"

const shipped = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "config",
  "context.yaml",
)

describe("context config", () => {
  it.effect("config/context.yaml decodes and matches the built-in defaults", () =>
    Effect.gen(function* () {
      expect(yield* loadContextConfig(shipped)).toEqual(DEFAULT_CONTEXT_CONFIG)
    }),
  )

  it.effect("a missing file is a ConfigError naming the path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadContextConfig("/nonexistent/context.yaml"))
      expect(error._tag).toBe("ConfigError")
      expect(error.key).toBe("/nonexistent/context.yaml")
    }),
  )

  it.effect("rejects invalid YAML and a shape error, naming the source", () =>
    Effect.gen(function* () {
      const syntax = yield* Effect.flip(decodeContextConfigText("budget: [", "ctx.yaml"))
      expect(syntax.message).toContain("invalid YAML")
      const shape = yield* Effect.flip(decodeContextConfigText("budget: { chat: 0 }", "ctx.yaml"))
      expect(shape.key).toBe("ctx.yaml")
    }),
  )

  it.effect("rejects a block cap that is not a positive integer", () =>
    Effect.gen(function* () {
      const text = [
        "budget: { chat: 1, decision: 1, light: 1, heavy: 1 }",
        "reserve_for_answer: 0",
        "blocks: { instructions: 1.5, rules: 1, memory: 1, code: 1, working: 1, acceptance: 1, task: 1 }",
        "levels: { top3: { memory: 1, code: 1 }, full: { memory: 1, code: 1 } }",
      ].join("\n")
      const error = yield* Effect.flip(decodeContextConfigText(text, "ctx.yaml"))
      expect(error._tag).toBe("ConfigError")
    }),
  )

  const textWith = (patch: { reserve?: number; blocks?: string; budget?: string }) =>
    [
      `budget: ${patch.budget ?? "{ chat: 2000, decision: 2000, light: 8000, heavy: 24000 }"}`,
      `reserve_for_answer: ${patch.reserve ?? 300}`,
      `blocks: ${patch.blocks ?? "{ instructions: 700, rules: 600, memory: 1500, code: 4000, working: 500, acceptance: 250, task: 150 }"}`,
      "levels: { top3: { memory: 3, code: 3 }, full: { memory: 8, code: 6 } }",
    ].join("\n")

  it.effect("accepts the built-in defaults and caps that exactly fill the smallest tier", () =>
    Effect.gen(function* () {
      expect(yield* decodeContextConfigText(textWith({}), "ctx.yaml")).toEqual(DEFAULT_CONTEXT_CONFIG)
    }),
  )

  it.effect("rejects fixed caps that do not fit the smallest tier minus the reserve", () =>
    Effect.gen(function* () {
      const blocks =
        "{ instructions: 700, rules: 601, memory: 1500, code: 4000, working: 500, acceptance: 250, task: 150 }"
      const error = yield* Effect.flip(decodeContextConfigText(textWith({ blocks }), "ctx.yaml"))
      expect(error._tag).toBe("ConfigError")
      expect(error.message).toContain("smallest tier")
    }),
  )

  it.effect("rejects a reserve that is not below every tier budget", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeContextConfigText(textWith({ reserve: 2000 }), "ctx.yaml"))
      expect(error.message).toContain("reserve_for_answer")
    }),
  )
})
