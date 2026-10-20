import { readFileSync } from "node:fs"
import { ConfigError, Effort, ExecutorId, ModelTier, type ModelTierMap } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import type { TierMapping } from "./claude-code/args.js"
import type { Executor } from "./executor.js"

// One tier of config/model-tiers.yaml. `alternatives` lists executors to try, in order, when `executor` is unavailable.
export const TierEntry = Schema.Struct({
  executor: ExecutorId,
  model: Schema.String.check(Schema.isMinLength(1)),
  effort: Schema.optionalKey(Effort),
  alternatives: Schema.optionalKey(Schema.Array(ExecutorId)),
})
export type TierEntry = typeof TierEntry.Type

// Every task kind maps to one tier. `system` is internal (never sent to an executor) but must still resolve.
export const TierRouting = Schema.Struct({
  code: ModelTier,
  research: ModelTier,
  plan: Schema.optionalKey(ModelTier),
  review: Schema.optionalKey(ModelTier),
  chat: ModelTier,
  status: Schema.optionalKey(ModelTier),
  system: ModelTier,
  app_op: ModelTier,
  routine: ModelTier,
})
export type TierRouting = typeof TierRouting.Type

export const TierConfig = Schema.Struct({
  model_tiers: Schema.Struct({
    chat: TierEntry,
    decision: TierEntry,
    light: TierEntry,
    heavy: TierEntry,
  }),
  routing: TierRouting,
})
export type TierConfig = typeof TierConfig.Type

// Validates the parsed content of config/model-tiers.yaml. Any shape problem is a ConfigError naming the source.
export const decodeTierConfig = (raw: unknown, source: string): Effect.Effect<TierConfig, ConfigError> =>
  Schema.decodeUnknownEffect(TierConfig)(raw).pipe(
    Effect.mapError((error) => new ConfigError({ key: source, message: error.message })),
  )

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Reads and validates config/model-tiers.yaml. The path comes from the composition root; this package never reads
// process.env. Missing file, YAML syntax error and shape error are all ConfigError, naming the path.
export const loadTierConfig = (path: string): Effect.Effect<TierConfig, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read tier config: ${describeCause(cause)}` }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: path, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    return yield* decodeTierConfig(raw, path)
  })

export interface ResolvedTier {
  readonly executor: ExecutorId
  readonly model: string
  readonly effort?: Effort
  // True when the tier's own executor was unavailable and an alternative answers.
  readonly fallback: boolean
}

// Precedence: the Bot's override for the tier, then the global entry. The fallback list always comes from the global
// entry. The first candidate whose executor is registered and reports quota().available wins. An alternative uses its
// own mapTier for the model, because the yaml model belongs to the primary executor only.
export const resolveTier = (
  config: TierConfig,
  botTiers: ModelTierMap,
  tier: ModelTier,
  executors: ReadonlyArray<Executor>,
): Effect.Effect<ResolvedTier, ConfigError> =>
  Effect.gen(function* () {
    const global = config.model_tiers[tier]
    const primary = botTiers[tier] ?? global
    const candidates: ReadonlyArray<ExecutorId> = [primary.executor, ...(global.alternatives ?? [])]
    for (const [index, id] of candidates.entries()) {
      const executor = executors.find((candidate) => candidate.id === id)
      if (executor === undefined) continue
      const status = yield* executor.quota()
      if (!status.available) continue
      if (index === 0) {
        return {
          executor: id,
          model: primary.model,
          ...(primary.effort === undefined ? {} : { effort: primary.effort }),
          fallback: false,
        }
      }
      const mapping = executor.mapTier(tier)
      return {
        executor: id,
        model: mapping.model,
        ...(mapping.effort === undefined ? {} : { effort: mapping.effort }),
        fallback: true,
      }
    }
    return yield* Effect.fail(
      new ConfigError({
        key: `model_tiers.${tier}`,
        message: `no available executor for tier ${tier} (tried: ${candidates.join(", ")})`,
      }),
    )
  })

// Mapping for one adapter: the tiers whose executor is this one take their model from the config; the rest use
// the adapter's own default. Pass the result as the adapter's `mapTier` option.
export const tierMappingFrom =
  (
    config: TierConfig,
    executor: ExecutorId,
    fallback: (tier: ModelTier) => TierMapping,
  ): ((tier: ModelTier) => TierMapping) =>
  (tier) => {
    const spec = config.model_tiers[tier]
    if (spec.executor !== executor) return fallback(tier)
    return { model: spec.model, ...(spec.effort === undefined ? {} : { effort: spec.effort }) }
  }
