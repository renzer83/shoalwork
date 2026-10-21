import { readFileSync } from "node:fs"
import { ConfigError } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import { FACTOR_MAX, FACTOR_MIN, type Factors } from "./tokenizer-approx.js"

const Factor = Schema.Number.check(Schema.isBetween({ minimum: FACTOR_MIN, maximum: FACTOR_MAX }))
const FactorTable = Schema.Struct({ code: Factor, prose_pt: Factor, prose_en: Factor })

// config/tokenizer.yaml. `executors` is keyed by executor id; `default` is required and serves the rest.
const Shape = Schema.Struct({
  cache: Schema.Struct({
    ttl_hours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 })),
    max_entries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  }),
  executors: Schema.Record(Schema.String, FactorTable),
})

const hasDefault = (config: typeof Shape.Type): true | string =>
  "default" in config.executors ? true : "executors must have a `default` entry"

export const TokenizerConfig = Shape.check(Schema.makeFilter(hasDefault))
export type TokenizerConfig = typeof TokenizerConfig.Type

// The values of config/tokenizer.yaml, for a Lead started without the file.
const DEFAULT_FACTORS: Factors = { code: 3.2, prose_pt: 3.5, prose_en: 4.0 }
export const DEFAULT_TOKENIZER_CONFIG: TokenizerConfig = {
  cache: { ttl_hours: 24, max_entries: 10_000 },
  executors: { default: DEFAULT_FACTORS },
}

// The initial factors of an executor: its own entry, or the default one (the filter guarantees it exists).
export const factorsFor = (config: TokenizerConfig, executor: string): Factors =>
  config.executors[executor] ?? config.executors.default ?? DEFAULT_FACTORS

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Pure: YAML text to validated config. Every failure is a ConfigError naming the source.
export const decodeTokenizerConfigText = (
  text: string,
  source: string,
): Effect.Effect<TokenizerConfig, ConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: source, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    return yield* Schema.decodeUnknownEffect(TokenizerConfig)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ key: source, message: error.message })),
    )
  })

// The path comes from the composition root; this package never reads process.env.
export const loadTokenizerConfig = (path: string): Effect.Effect<TokenizerConfig, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read tokenizer config: ${describeCause(cause)}` }),
    })
    return yield* decodeTokenizerConfigText(text, path)
  })
