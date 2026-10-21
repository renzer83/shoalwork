import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { ConfigError, ExecutorId } from "@shoalwork/contracts"
import { loadQuotaConfig } from "@shoalwork/executors"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { resolveRepoPath } from "../src/config.js"

const SHIPPED = resolveRepoPath("config/quotas.yaml")
const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")
const CHAT = Schema.decodeUnknownSync(ExecutorId)("claude-code@chat")
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe("loadQuotaConfig at boot", () => {
  it.effect("the shipped config/quotas.yaml loads with the claude-code and codex windows", () =>
    Effect.gen(function* () {
      const config = yield* loadQuotaConfig(SHIPPED)
      expect(config.executors[CLAUDE]?.windows.map((window) => window.kind)).toEqual(["5h", "7d"])
      expect(config.executors[CODEX]?.windows.map((window) => window.kind)).toEqual(["5h", "7d"])
    }),
  )

  it.effect("an invalid file is a ConfigError naming the file, so the core does not boot on it", () =>
    Effect.gen(function* () {
      const path = fixture("quotas-invalid.yaml")
      const error = yield* Effect.flip(loadQuotaConfig(path))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(path)
    }),
  )

  it.effect("a missing file is a ConfigError too: quotas have no built-in defaults", () =>
    Effect.gen(function* () {
      const path = fixture("does-not-exist-quotas.yaml")
      const error = yield* Effect.flip(loadQuotaConfig(path))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(path)
    }),
  )

  it.effect("the shipped file names no window for the chat adapter (the quota route refuses it)", () =>
    Effect.gen(function* () {
      const config = yield* loadQuotaConfig(SHIPPED)
      expect(config.executors[CHAT]).toBeUndefined()
    }),
  )
})
