import { readFileSync } from "node:fs"
import { ConfigError, ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"

// Length of a quota window. "custom" is not configurable yet: no executor needs one.
export const WindowKind = Schema.Literals(["5h", "7d"])
export type WindowKind = typeof WindowKind.Type

export const WINDOW_MS: Readonly<Record<WindowKind, number>> = {
  "5h": 5 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
}

const PositiveNumber = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
  Schema.check(Schema.isGreaterThan(0)),
)

// One window of config/quotas.yaml. The soft limits are the ones the store compares usage against.
export const QuotaWindow = Schema.Struct({
  kind: WindowKind,
  soft_tokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  soft_usd: Schema.optionalKey(PositiveNumber),
})
export type QuotaWindow = typeof QuotaWindow.Type

export const QuotaConfig = Schema.Struct({
  executors: Schema.Record(ExecutorId, Schema.Struct({ windows: Schema.Array(QuotaWindow) })),
})
export type QuotaConfig = typeof QuotaConfig.Type

// Validates the parsed content of config/quotas.yaml. Any shape problem is a ConfigError naming the source.
export const decodeQuotaConfig = (raw: unknown, source: string): Effect.Effect<QuotaConfig, ConfigError> =>
  Schema.decodeUnknownEffect(QuotaConfig)(raw).pipe(
    Effect.mapError((error) => new ConfigError({ key: source, message: error.message })),
  )

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Reads and validates config/quotas.yaml. The path comes from the composition root; this package never reads
// process.env. Missing file, YAML syntax error and shape error are all ConfigError, naming the path.
export const loadQuotaConfig = (path: string): Effect.Effect<QuotaConfig, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read quota config: ${describeCause(cause)}` }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: path, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    return yield* decodeQuotaConfig(raw, path)
  })

// Windows of one executor, in config order. An executor missing from the file has no windows (no limit is known).
export const windowsOf = (config: QuotaConfig, executor: ExecutorId): ReadonlyArray<QuotaWindow> =>
  config.executors[executor]?.windows ?? []
