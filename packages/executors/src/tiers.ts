import { readFileSync } from "node:fs"
import {
  ConfigError,
  Effort,
  ExecutorId,
  ModelTier,
  type ModelTierMap,
  type TaskKind,
} from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import type { TierMapping } from "./claude-code/args.js"
import type { Executor } from "./executor.js"
import {
  DEFAULT_ROUTE_WEIGHTS,
  type RankedExecutor,
  type RouteQuality,
  RouteWeights,
  rankExecutors,
} from "./routing.js"

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
  // Score weights of the executor ranking (routing.ts). Missing → DEFAULT_ROUTE_WEIGHTS.
  weights: Schema.optionalKey(RouteWeights),
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
  // True when the tier's own executor was unavailable (or ranked below an alternative) and another answers.
  readonly fallback: boolean
  // Only with a route: the reasons of the chosen executor's score (routing.ts).
  readonly reasons?: ReadonlyArray<string>
}

// Quality history for the ranking. `kind` is the task kind the run is routed for.
export interface RouteOptions {
  readonly kind: TaskKind
  readonly quality: ReadonlyArray<RouteQuality>
}

// Precedence: the Bot's override for the tier, then the global entry. The fallback list always comes from the global
// entry. The first candidate whose executor is registered and reports quota().available wins. An alternative uses its
// own mapTier for the model, because the yaml model belongs to the primary executor only.
// `exclude` lists executors that may not serve this resolution (e.g. the worker's executor, for a reviewer).
// With `route`, the candidates are ranked by rankExecutors instead (quality, quota, cost); ties keep the yaml order.
export const resolveTier = (
  config: TierConfig,
  botTiers: ModelTierMap,
  tier: ModelTier,
  executors: ReadonlyArray<Executor>,
  options: { readonly exclude?: ReadonlyArray<ExecutorId>; readonly route?: RouteOptions } = {},
): Effect.Effect<ResolvedTier, ConfigError> =>
  Effect.gen(function* () {
    const global = config.model_tiers[tier]
    const primary = botTiers[tier] ?? global
    const excluded = options.exclude ?? []
    if (options.route !== undefined) {
      return yield* resolveRanked(config, botTiers, tier, executors, options.route, excluded)
    }
    const candidates = candidatesOf(config, botTiers, tier, excluded)
    for (const id of candidates) {
      const executor = executors.find((candidate) => candidate.id === id)
      if (executor === undefined) continue
      const status = yield* executor.quota()
      if (!status.available) continue
      if (id === primary.executor) {
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
    return yield* Effect.fail(noExecutorError(tier, candidates, excluded))
  })

// The primary executor of the tier (Bot override first, then global) and the global alternatives, in yaml order,
// without the excluded ones.
const candidatesOf = (
  config: TierConfig,
  botTiers: ModelTierMap,
  tier: ModelTier,
  excluded: ReadonlyArray<ExecutorId>,
): ReadonlyArray<ExecutorId> => {
  const global = config.model_tiers[tier]
  const primary = botTiers[tier] ?? global
  return [primary.executor, ...(global.alternatives ?? [])].filter((id) => !excluded.includes(id))
}

const noExecutorError = (
  tier: ModelTier,
  candidates: ReadonlyArray<ExecutorId>,
  excluded: ReadonlyArray<ExecutorId>,
): ConfigError =>
  new ConfigError({
    key: `model_tiers.${tier}`,
    message: `no available executor for tier ${tier} (tried: ${candidates.join(", ") || "none"}${excluded.length === 0 ? "" : `; excluded: ${excluded.join(", ")}`})`,
  })

// Ranks the candidates of a tier for `kind` (rankExecutors). Only executors that are registered are ranked, in yaml
// order; an alternative that is not registered is never a candidate, so it cannot win by its missing history. Repeats
// and `exclude` are dropped. quota() is read once per ranked candidate. Weights come from routing.weights of the config.
export const rankTier = (
  config: TierConfig,
  botTiers: ModelTierMap,
  tier: ModelTier,
  kind: TaskKind,
  executors: ReadonlyArray<Executor>,
  quality: ReadonlyArray<RouteQuality>,
  exclude: ReadonlyArray<ExecutorId> = [],
): Effect.Effect<ReadonlyArray<RankedExecutor>> =>
  Effect.gen(function* () {
    const candidates = candidatesOf(config, botTiers, tier, exclude).filter(
      (id, index, all) => all.indexOf(id) === index && executors.some((executor) => executor.id === id),
    )
    const registered = executors.filter((executor) => candidates.includes(executor.id))
    const quota = yield* Effect.forEach(registered, (executor) => executor.quota())
    return rankExecutors(kind, candidates, {
      quality,
      quota,
      weights: config.routing.weights ?? DEFAULT_ROUTE_WEIGHTS,
    })
  })

// The route picks the best eligible candidate. `fallback` is true when that is not the tier's own executor.
const resolveRanked = (
  config: TierConfig,
  botTiers: ModelTierMap,
  tier: ModelTier,
  executors: ReadonlyArray<Executor>,
  route: RouteOptions,
  excluded: ReadonlyArray<ExecutorId>,
): Effect.Effect<ResolvedTier, ConfigError> =>
  Effect.gen(function* () {
    const primary = botTiers[tier] ?? config.model_tiers[tier]
    const ranked = yield* rankTier(config, botTiers, tier, route.kind, executors, route.quality, excluded)
    const winner = ranked.find((entry) => Number.isFinite(entry.score))
    const chosen =
      winner === undefined ? undefined : executors.find((executor) => executor.id === winner.executor)
    if (winner === undefined || chosen === undefined) {
      return yield* Effect.fail(
        noExecutorError(tier, candidatesOf(config, botTiers, tier, excluded), excluded),
      )
    }
    if (winner.executor === primary.executor) {
      return {
        executor: winner.executor,
        model: primary.model,
        ...(primary.effort === undefined ? {} : { effort: primary.effort }),
        fallback: false,
        reasons: winner.reasons,
      }
    }
    const mapping = chosen.mapTier(tier)
    return {
      executor: winner.executor,
      model: mapping.model,
      ...(mapping.effort === undefined ? {} : { effort: mapping.effort }),
      fallback: true,
      reasons: winner.reasons,
    }
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
