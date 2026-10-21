import { readFileSync } from "node:fs"
import { ConfigError } from "@shoalwork/contracts"
import { DEFAULT_WEIGHTS, RankWeights } from "@shoalwork/reef"
import { Effect, Schema } from "effect"
import { parse } from "yaml"

const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000 }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

// levels: the deepest compaction level allowed (1 = no comments, blank lines or imports; 2 and 3 = summaries).
// minItemTokens: an item smaller than this is not summarized. cache_ttl_hours: how long a summary is reused.
const Compaction = Schema.Struct({
  levels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  minItemTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  cache_ttl_hours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8760 })),
})
export type CompactionConfig = typeof Compaction.Type

// config/context.yaml. Budgets are in tokens (chars / 4); `reserve_for_answer` is taken from the tier's budget before
// anything is assembled. `blocks` are the per-block caps. `levels` say how many items each non-"none" level asks for.
const Shape = Schema.Struct({
  budget: Schema.Struct({ chat: Tokens, decision: Tokens, light: Tokens, heavy: Tokens }),
  reserve_for_answer: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  blocks: Schema.Struct({
    instructions: Tokens,
    rules: Tokens,
    memory: Tokens,
    code: Tokens,
    git: Tokens,
    docs: Tokens,
    working: Tokens,
    acceptance: Tokens,
    task: Tokens,
  }),
  levels: Schema.Struct({
    top3: Schema.Struct({ memory: Count, code: Count }),
    full: Schema.Struct({ memory: Count, code: Count }),
  }),
  // Ranking of code candidates (T-096): six weights that add up to 1. Weights stored by the weekly tuning win over these.
  rank: Schema.optionalKey(Schema.Struct({ weights: RankWeights })),
  // Compaction of blocks that do not fit (T-097), before anything is dropped.
  compaction: Schema.optionalKey(Compaction),
})

// The blocks that are not cut in the normal course (see assemble): their caps together have to fit the smallest tier,
// or a run on that tier could not keep to its budget.
const FIXED_BLOCKS = ["instructions", "rules", "acceptance", "task"] as const

const fits = (config: typeof Shape.Type): true | string => {
  const smallest = Math.min(...Object.values(config.budget))
  if (config.reserve_for_answer >= smallest) {
    return `reserve_for_answer (${config.reserve_for_answer}) must be below every tier budget (smallest: ${smallest})`
  }
  const room = smallest - config.reserve_for_answer
  const fixed = FIXED_BLOCKS.reduce((sum, name) => sum + config.blocks[name], 0)
  return fixed <= room
    ? true
    : `the caps of ${FIXED_BLOCKS.join(", ")} add up to ${fixed} tokens, more than the ${room} left in the smallest tier (budget ${smallest} - reserve_for_answer ${config.reserve_for_answer})`
}

export const ContextConfig = Shape.check(Schema.makeFilter(fits))
export type ContextConfig = typeof ContextConfig.Type

// The compaction of config/context.yaml when the file has no such section (or the Lead starts without the file).
export const DEFAULT_COMPACTION: CompactionConfig = { levels: 3, minItemTokens: 60, cache_ttl_hours: 168 }

// The values of config/context.yaml, for a Lead started without the file.
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  budget: { chat: 2000, decision: 2000, light: 8000, heavy: 24000 },
  reserve_for_answer: 300,
  blocks: {
    instructions: 700,
    rules: 600,
    memory: 1500,
    code: 4000,
    git: 800,
    docs: 1200,
    working: 500,
    acceptance: 250,
    task: 150,
  },
  levels: {
    top3: { memory: 3, code: 3 },
    full: { memory: 8, code: 6 },
  },
  rank: { weights: DEFAULT_WEIGHTS },
  compaction: DEFAULT_COMPACTION,
}

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Pure: YAML text to validated config. Every failure is a ConfigError naming the source.
export const decodeContextConfigText = (
  text: string,
  source: string,
): Effect.Effect<ContextConfig, ConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: source, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    const decoded = yield* Schema.decodeUnknownEffect(ContextConfig)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ key: source, message: error.message })),
    )
    // A file written before the ranking (T-096) or the compaction (T-097) existed gets their defaults.
    return {
      ...decoded,
      rank: decoded.rank ?? { weights: DEFAULT_WEIGHTS },
      compaction: decoded.compaction ?? DEFAULT_COMPACTION,
    }
  })

// The path comes from the composition root; this package never reads process.env.
export const loadContextConfig = (path: string): Effect.Effect<ContextConfig, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read context config: ${describeCause(cause)}` }),
    })
    return yield* decodeContextConfigText(text, path)
  })
