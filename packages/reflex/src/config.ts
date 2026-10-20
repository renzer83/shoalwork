import { readFileSync } from "node:fs"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import { STANDARD_IDS } from "./contract.js"

// A word must contain at least one non-space character.
const Word = Schema.String.check(Schema.isMinLength(1)).check(Schema.isPattern(/\S/))
const Words = Schema.Array(Word).check(Schema.isMinLength(1))
const Confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Chars = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))

export const DEFAULT_LIMITS = { ruleChars: 8000, payloadChars: 2000 } as const

const STANDARD_ID_SET: ReadonlySet<string> = new Set<string>(STANDARD_IDS)

// Optional per-question overrides; a key outside the standard ids is a schema error.
const PerQuestion = Schema.Record(Schema.String, Confidence).check(
  Schema.makeFilter(
    (record: Readonly<Record<string, number>>) =>
      Object.keys(record).every((key) => STANDARD_ID_SET.has(key)) || "unknown question id in perQuestion",
  ),
)

const Limits = Schema.Struct({
  ruleChars: Schema.optionalKey(Chars),
  payloadChars: Schema.optionalKey(Chars),
})

export const ReflexConfig = Schema.Struct({
  thresholds: Schema.Struct({
    default: Confidence,
    perQuestion: PerQuestion,
  }),
  intent: Schema.Struct({
    code: Words,
    research: Words,
    app_op: Words,
    routine: Words,
  }),
  verbs: Words,
  sequence: Words,
  risk: Schema.Struct({ high: Words, external: Words, local: Words }),
  language: Schema.Struct({ pt: Words, en: Words, es: Words }),
  owner: Schema.Struct({ roles: Words, leadName: Word }),
  limits: Schema.optionalKey(Limits),
})
export type ReflexConfig = typeof ReflexConfig.Type

// Limits in characters: rules read at most `ruleChars` of the text; the decision payload keeps `payloadChars`.
export const limitsOf = (
  config: ReflexConfig,
): { readonly ruleChars: number; readonly payloadChars: number } => ({
  ruleChars: config.limits?.ruleChars ?? DEFAULT_LIMITS.ruleChars,
  payloadChars: config.limits?.payloadChars ?? DEFAULT_LIMITS.payloadChars,
})

// Pure: YAML text to validated config. Every failure is a SchemaViolation at `where`.
export const decodeReflexConfigText = (
  text: string,
  where: string,
): Effect.Effect<ReflexConfig, SchemaViolation> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new SchemaViolation({ where, issue: cause }),
    })
    return yield* Schema.decodeUnknownEffect(ReflexConfig)(raw).pipe(
      Effect.mapError((e) => new SchemaViolation({ where, issue: e.issue })),
    )
  })

// The path comes from the caller (composition root); this package never reads process.env.
// A missing or unreadable file is a SchemaViolation at the path.
export const loadReflexConfig = (path: string): Effect.Effect<ReflexConfig, SchemaViolation> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) => new SchemaViolation({ where: path, issue: cause }),
    })
    return yield* decodeReflexConfigText(text, path)
  })

// Strictly below the threshold of the question; the threshold itself passes. T-024 escalates on this.
export const belowThreshold = (config: ReflexConfig, questionId: string, confidence: number): boolean => {
  const override = Object.entries(config.thresholds.perQuestion).find(([id]) => id === questionId)?.[1]
  return confidence < (override ?? config.thresholds.default)
}
