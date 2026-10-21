import { readFileSync } from "node:fs"
import { ConfigError } from "@shoalwork/contracts"
import { DEFAULT_WEIGHTS, RankWeights } from "@shoalwork/reef"
import { Effect, Schema } from "effect"
import { parse } from "yaml"

const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000 }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

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

// The values of config/context.yaml, for a Lead started without the file.
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  budget: { chat: 2000, decision: 2000, light: 8000, heavy: 24000 },
  reserve_for_answer: 300,
  blocks: {
    instructions: 700,
    rules: 600,
    memory: 1500,
    code: 4000,
    working: 500,
    acceptance: 250,
    task: 150,
  },
  levels: {
    top3: { memory: 3, code: 3 },
    full: { memory: 8, code: 6 },
  },
  rank: { weights: DEFAULT_WEIGHTS },
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
    // A file written before the ranking existed gets the default weights.
    return decoded.rank === undefined ? { ...decoded, rank: { weights: DEFAULT_WEIGHTS } } : decoded
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
