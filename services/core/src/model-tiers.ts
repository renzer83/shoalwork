import { existsSync } from "node:fs"
import type { ConfigError, ModelTier } from "@shoalwork/contracts"
import { CODEX_ID, loadTierConfig, TierConfig } from "@shoalwork/executors"
import { Effect, Schema } from "effect"

// Used when config/model-tiers.yaml does not exist. Same content as the shipped file, so the adapters' built-in
// mappings and the Lead's executor choice agree with it (a test keeps the two in step).
export const DEFAULT_TIERS: TierConfig = Schema.decodeUnknownSync(TierConfig)({
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
})

// A file that exists must be valid: a broken table stops the core from booting. A missing file means the defaults.
export const loadModelTiers = (path: string): Effect.Effect<TierConfig, ConfigError> =>
  Effect.suspend(
    (): Effect.Effect<TierConfig, ConfigError> =>
      existsSync(path)
        ? loadTierConfig(path)
        : Effect.logWarning(`model tiers file not found, using built-in defaults: ${path}`).pipe(
            Effect.as(DEFAULT_TIERS),
          ),
  )

const TIERS: ReadonlyArray<ModelTier> = ["chat", "decision", "light", "heavy"]

// Models of the codex adapter. A tier whose yaml entry names codex takes that model; every other tier takes the
// CODEX_MODEL fallback. No model at all means codex keeps its own default (no -m flag).
export const codexModelsFrom = (
  tiers: TierConfig,
  fallback: string | undefined,
): Partial<Record<ModelTier, string>> | undefined => {
  const models: Partial<Record<ModelTier, string>> = {}
  for (const tier of TIERS) {
    const spec = tiers.model_tiers[tier]
    if (spec.executor === CODEX_ID) {
      models[tier] = spec.model
    } else if (fallback !== undefined) {
      models[tier] = fallback
    }
  }
  return Object.keys(models).length === 0 ? undefined : models
}
