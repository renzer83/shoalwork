import { randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import {
  ConfigError,
  ExecutorId,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
  type ModelTierMap,
} from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it as plainIt } from "vitest"
import { buildArgs, buildChatArgs, defaultChatMapTier } from "../src/claude-code/args.js"
import { makeClaudeCodeChat } from "../src/claude-code/chat.js"
import { defaultMapTier, makeClaudeCode } from "../src/claude-code/index.js"
import type { Executor } from "../src/executor.js"
import { decodeTierConfig, resolveTier, TierConfig, tierMappingFrom } from "../src/tiers.js"

const id = (value: string) => Schema.decodeUnknownSync(ExecutorId)(value)

// Same content as config/model-tiers.yaml (the yaml parser is not a dependency of this package, so the test
// carries the parsed shape; the file itself is checked by hand when it changes).
const SHIPPED = {
  model_tiers: {
    chat: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    decision: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    light: { executor: "claude-code", model: "claude-haiku-5-5", effort: "high" },
    heavy: { executor: "claude-code", model: "claude-opus-5-5", effort: "high", alternatives: ["codex"] },
  },
  routing: {
    code: "heavy",
    research: "heavy",
    plan: "heavy",
    review: "heavy",
    chat: "chat",
    status: "chat",
    system: "chat",
    app_op: "light",
    routine: "light",
  },
}

const config = (): TierConfig => Effect.runSync(decodeTierConfig(SHIPPED, "config/model-tiers.yaml"))

const stub = (value: string, options: { available?: boolean; model?: string } = {}): Executor => ({
  id: id(value),
  run: () => Stream.empty,
  mapTier: () => ({ model: options.model ?? `${value}-model` }),
  quota: () => Effect.succeed({ executor: id(value), usedRatio: 0, available: options.available ?? true }),
})

const noOverride: ModelTierMap = {}

const task = (overrides: Partial<ExecutorTask> = {}): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "say hi",
    tier: "chat",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 1,
    budget: { tokens: 1000, seconds: 60, usd: 0.1 },
    ...overrides,
  })

describe("decodeTierConfig", () => {
  plainIt("accepts the shipped tiers and round-trips them", () => {
    const decoded = Effect.runSync(decodeTierConfig(SHIPPED, "x"))
    expect(Effect.runSync(Schema.encodeUnknownEffect(TierConfig)(decoded))).toEqual(SHIPPED)
  })

  plainIt("rejects an executor id with ':' (the chat adapter is claude-code@chat)", () => {
    const bad = structuredClone(SHIPPED)
    bad.model_tiers.chat.executor = "claude-code:chat"
    const error = Effect.runSync(Effect.flip(decodeTierConfig(bad, "model-tiers.yaml")))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.key).toBe("model-tiers.yaml")
  })

  plainIt("rejects a config without the heavy tier", () => {
    const bad = structuredClone(SHIPPED) as Record<string, unknown>
    delete (bad.model_tiers as Record<string, unknown>).heavy
    expect(Effect.runSync(Effect.flip(decodeTierConfig(bad, "x")))).toBeInstanceOf(ConfigError)
  })

  plainIt("rejects a tier value outside chat, decision, light and heavy", () => {
    const bad = structuredClone(SHIPPED)
    ;(bad.routing as Record<string, string>).code = "huge"
    expect(Effect.runSync(Effect.flip(decodeTierConfig(bad, "x")))).toBeInstanceOf(ConfigError)
  })

  plainIt("rejects a routing table that misses a task kind", () => {
    const bad = structuredClone(SHIPPED) as { routing: Record<string, string> }
    delete bad.routing.app_op
    expect(Effect.runSync(Effect.flip(decodeTierConfig(bad, "x")))).toBeInstanceOf(ConfigError)
  })

  plainIt("rejects a non-object document", () => {
    expect(Effect.runSync(Effect.flip(decodeTierConfig("not a map", "x")))).toBeInstanceOf(ConfigError)
  })
})

describe("resolveTier", () => {
  it.effect("uses the global entry when the Bot has no override", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTier(config(), noOverride, "light", [stub("claude-code")])
      expect(resolved).toEqual({
        executor: "claude-code",
        model: "claude-haiku-5-5",
        effort: "high",
        fallback: false,
      })
    }),
  )

  it.effect("a Bot override wins over the global entry for executor, model and effort", () =>
    Effect.gen(function* () {
      const override: ModelTierMap = {
        heavy: { executor: id("claude-code"), model: "claude-sonnet-5-5", effort: "medium" },
      }
      const resolved = yield* resolveTier(config(), override, "heavy", [stub("claude-code"), stub("codex")])
      expect(resolved).toEqual({
        executor: "claude-code",
        model: "claude-sonnet-5-5",
        effort: "medium",
        fallback: false,
      })
    }),
  )

  it.effect("a Bot override can point the tier to another executor", () =>
    Effect.gen(function* () {
      const override: ModelTierMap = { light: { executor: id("codex"), model: "gpt-x" } }
      const resolved = yield* resolveTier(config(), override, "light", [stub("claude-code"), stub("codex")])
      expect(resolved).toEqual({ executor: "codex", model: "gpt-x", fallback: false })
    }),
  )

  it.effect("falls back to the first available alternative when the executor reports unavailable", () =>
    Effect.gen(function* () {
      const executors = [stub("claude-code", { available: false }), stub("codex", { model: "gpt-codex" })]
      const resolved = yield* resolveTier(config(), noOverride, "heavy", executors)
      expect(resolved.executor).toBe("codex")
      expect(resolved.fallback).toBe(true)
      // The yaml model belongs to claude-code; the alternative answers with its own mapTier.
      expect(resolved.model).toBe("gpt-codex")
    }),
  )

  it.effect("falls back when the tier's executor is not registered", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTier(config(), noOverride, "heavy", [stub("codex")])
      expect(resolved).toEqual({ executor: "codex", model: "codex-model", fallback: true })
    }),
  )

  it.effect("skips an unavailable alternative and takes the next one", () =>
    Effect.gen(function* () {
      const custom: TierConfig = {
        ...config(),
        model_tiers: {
          ...config().model_tiers,
          heavy: {
            executor: id("claude-code"),
            model: "claude-opus-5-5",
            alternatives: [id("codex"), id("gemini")],
          },
        },
      }
      const executors = [
        stub("claude-code", { available: false }),
        stub("codex", { available: false }),
        stub("gemini"),
      ]
      const resolved = yield* resolveTier(custom, noOverride, "heavy", executors)
      expect(resolved.executor).toBe("gemini")
      expect(resolved.fallback).toBe(true)
    }),
  )

  it.effect("fails with ConfigError when no candidate is available", () =>
    Effect.gen(function* () {
      const executors = [stub("claude-code", { available: false }), stub("codex", { available: false })]
      const error = yield* Effect.flip(resolveTier(config(), noOverride, "heavy", executors))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe("model_tiers.heavy")
    }),
  )
})

describe("tierMappingFrom", () => {
  it("gives the config model to the tiers of its own executor and the default to the others", () => {
    const mapping = tierMappingFrom(config(), id("claude-code"), defaultMapTier)
    expect(mapping("heavy")).toEqual({ model: "claude-opus-5-5", effort: "high" })
    expect(mapping("light")).toEqual({ model: "claude-haiku-5-5", effort: "high" })
    // chat and decision belong to claude-code@chat, so this adapter keeps its default for them.
    expect(mapping("chat")).toEqual(defaultMapTier("chat"))
  })

  it("the chat adapter takes chat and decision from the config", () => {
    const custom = config()
    const mapping = tierMappingFrom(custom, id("claude-code@chat"), defaultChatMapTier)
    expect(mapping("decision")).toEqual({ model: "claude-haiku-5-5", effort: "low" })
    expect(mapping("heavy")).toEqual(defaultChatMapTier())
  })
})

describe("adapter mapTier injection", () => {
  it("claude-code uses the injected mapping for the model flag", () => {
    const executor = makeClaudeCode({ mapTier: () => ({ model: "injected-model", effort: "low" }) })
    expect(executor.mapTier("heavy")).toEqual({ model: "injected-model", effort: "low" })
    const args = buildArgs(task({ tier: "heavy" }), executor.mapTier)
    expect(args).toContain("injected-model")
    expect(args).not.toContain("claude-opus-5-5")
  })

  it("claude-code keeps its default mapping when none is injected", () => {
    expect(makeClaudeCode().mapTier("heavy")).toEqual({ model: "claude-opus-5-5", effort: "high" })
  })

  it("chat uses the injected mapping, and omits --effort when the mapping has none", () => {
    const executor = makeClaudeCodeChat({ mapTier: () => ({ model: "injected-chat" }) })
    expect(executor.mapTier("chat")).toEqual({ model: "injected-chat" })
    const args = buildChatArgs(task({ tier: "chat" }), () => ({ model: "injected-chat" }))
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "json", "--model", "injected-chat", "--tools"])
    expect(args).not.toContain("--effort")
  })
})

describe("resolveTier exclude", () => {
  it.effect("an excluded primary executor is replaced by the first allowed alternative, as a fallback", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTier(
        config(),
        noOverride,
        "heavy",
        [stub("claude-code"), stub("codex")],
        {
          exclude: [id("claude-code")],
        },
      )
      expect(resolved).toEqual({ executor: "codex", model: "codex-model", fallback: true })
    }),
  )

  it.effect("fails with the excluded executors named when no other executor is left", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveTier(config(), noOverride, "heavy", [stub("claude-code"), stub("codex")], {
          exclude: [id("claude-code"), id("codex")],
        }),
      )
      expect(error.message).toContain("excluded: claude-code, codex")
    }),
  )
})
