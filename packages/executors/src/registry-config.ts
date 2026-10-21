import { readFileSync } from "node:fs"
import { ConfigError, ExecutorId, ExecutorSpawnError } from "@shoalwork/contracts"
import { Effect, Redacted, Schema, Stream } from "effect"
import { parse } from "yaml"
import { defaultMapTier, makeClaudeCode } from "./claude-code/index.js"
import type { CodexModels } from "./codex/args.js"
import { makeCodexExecutor } from "./codex/index.js"
import { CodexProvider } from "./codex/provider.js"
import type { Executor } from "./executor.js"
import { makeForja } from "./forja/index.js"
import { makeOpenAICompat, type OpenAICompatPolicy } from "./openai-compat/index.js"
import type { QuotaStoreShape } from "./quota/store.js"
import { type TierConfig, tierMappingFrom } from "./tiers.js"

// The core env names a `${NAME}` may reference in config/executors.yaml (ADR-011). Nothing else of the env is read.
export const EXPANDABLE_ENV: ReadonlyArray<string> = ["ZAI_API_KEY"]

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const BaseUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s"]+$/))

const ClaudeCodeSpec = Schema.Struct({
  id: ExecutorId,
  kind: Schema.Literal("claude-code"),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

const CodexSpec = Schema.Struct({
  id: ExecutorId,
  kind: Schema.Literal("codex"),
  model: Schema.optionalKey(NonEmpty),
  codexProvider: Schema.optionalKey(CodexProvider),
})

const OpenAICompatSpec = Schema.Struct({
  id: ExecutorId,
  kind: Schema.Literal("openai-compat"),
  baseUrl: BaseUrl,
  apiKey: Schema.optionalKey(Schema.String),
  defaultModel: NonEmpty,
  supportsTools: Schema.Boolean,
})

const ForjaSpec = Schema.Struct({
  id: ExecutorId,
  kind: Schema.Literal("forja"),
  bin: NonEmpty,
})

// One instance per entry; `kind` picks the adapter. Unknown keys are rejected by the decode of the entry's kind.
export const ExecutorSpec = Schema.Union([ClaudeCodeSpec, CodexSpec, OpenAICompatSpec, ForjaSpec])
export type ExecutorSpec = typeof ExecutorSpec.Type

export const ExecutorsConfig = Schema.Struct({ executors: Schema.Array(ExecutorSpec) })
export type ExecutorsConfig = typeof ExecutorsConfig.Type

// What the adapters are built from. The env is the core's; only EXPANDABLE_ENV names are read from it.
export type ExecutorsConfigDeps = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly onPath: (bin: string) => boolean
  readonly tiers: TierConfig
  readonly quota: QuotaStoreShape | undefined
  readonly permissionBridge: boolean
  // codex models from the tier table and CODEX_MODEL; used by a codex instance without its own `model`.
  readonly codexModels: CodexModels | undefined
  // Counter window of codex when no quota store is injected (the 5h window of config/quotas.yaml).
  readonly codexCounter: { readonly windowSeconds: number; readonly softLimitTokens: number }
  readonly policy: OpenAICompatPolicy
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Every `${...}` in the file must name an allowed env var. A typo is a config error, not a silent empty value.
const checkReferences = (text: string, source: string): Effect.Effect<void, ConfigError> => {
  const values = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
  const rejected = [...values.matchAll(/\$\{([^}]*)\}/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => !EXPANDABLE_ENV.includes(name))
  const first = rejected[0]
  return first === undefined
    ? Effect.void
    : Effect.fail(new ConfigError({ key: source, message: `env reference not allowed: ${first}` }))
}

// Expands ${NAME} with the allowlisted lookup. A name without a value is reported, never printed with a value.
const expand = (
  text: string,
  lookup: (name: string) => string | undefined,
): { readonly text: string; readonly missing: ReadonlyArray<string> } => {
  const missing: Array<string> = []
  const expanded = text.replace(REFERENCE, (_whole: string, name: string): string => {
    const value = lookup(name)
    if (value === undefined || value.trim() === "") {
      missing.push(name)
      return ""
    }
    return value
  })
  return { text: expanded, missing }
}

const missingReason = (missing: ReadonlyArray<string>): string | undefined =>
  missing.length === 0 ? undefined : `missing env value: ${[...new Set(missing)].join(", ")}`

// An instance whose prerequisite is missing stays listed, reports available=false and refuses to run (no error at boot).
const gated = (executor: Executor, reason: string | undefined): Executor =>
  reason === undefined
    ? executor
    : {
        id: executor.id,
        mapTier: executor.mapTier,
        quota: () => Effect.map(executor.quota(), (status) => ({ ...status, available: false })),
        run: () => Stream.fail(new ExecutorSpawnError({ executor: executor.id, cause: reason })),
      }

const modelsForAll = (model: string): CodexModels => ({
  chat: model,
  decision: model,
  light: model,
  heavy: model,
})

// Undefined: the instance is not listed on this host (a codex instance without the codex binary, as before T-080).
const buildExecutor = (spec: ExecutorSpec, deps: ExecutorsConfigDeps): Executor | undefined => {
  const lookup = (name: string): string | undefined =>
    EXPANDABLE_ENV.includes(name) ? deps.env[name] : undefined
  switch (spec.kind) {
    case "claude-code": {
      const values: Record<string, string> = {}
      const missing: Array<string> = []
      for (const [key, raw] of Object.entries(spec.env ?? {})) {
        const expanded = expand(raw, lookup)
        values[key] = expanded.text
        missing.push(...expanded.missing)
      }
      const executor = makeClaudeCode({
        id: spec.id,
        envOverrides: values,
        mapTier: tierMappingFrom(deps.tiers, spec.id, defaultMapTier),
        permissionBridge: deps.permissionBridge,
        ...(deps.quota === undefined ? {} : { quota: deps.quota }),
      })
      return gated(executor, missingReason(missing))
    }
    case "codex": {
      if (!deps.onPath("codex")) return undefined
      const models = spec.model === undefined ? deps.codexModels : modelsForAll(spec.model)
      return makeCodexExecutor({
        id: spec.id,
        quotaWindowSeconds: deps.codexCounter.windowSeconds,
        quotaSoftLimitTokens: deps.codexCounter.softLimitTokens,
        ...(deps.quota === undefined ? {} : { quota: deps.quota }),
        ...(models === undefined ? {} : { models }),
        ...(spec.codexProvider === undefined ? {} : { provider: spec.codexProvider }),
      })
    }
    case "openai-compat": {
      const key = spec.apiKey === undefined ? undefined : expand(spec.apiKey, lookup)
      const executor = makeOpenAICompat({
        id: spec.id,
        baseUrl: spec.baseUrl,
        defaultModel: spec.defaultModel,
        supportsTools: spec.supportsTools,
        policy: deps.policy,
        ...(key === undefined ? {} : { apiKey: Redacted.make(key.text) }),
      })
      return gated(executor, missingReason(key?.missing ?? []))
    }
    case "forja":
      return makeForja({ bin: spec.bin, onPath: deps.onPath })
  }
}

// Reads and validates config/executors.yaml and builds one executor per entry. A missing file, a YAML error, a shape
// error, a reference outside EXPANDABLE_ENV or a duplicate id is a ConfigError naming the file. A missing env value is
// not an error: that instance is listed as unavailable. A missing binary is not listed for codex, and forja reports
// available=false.
export const loadExecutorsConfig = (
  path: string,
  deps: ExecutorsConfigDeps,
): Effect.Effect<ReadonlyArray<Executor>, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read executors config: ${describeCause(cause)}` }),
    })
    yield* checkReferences(text, path)
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: path, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    const config = yield* Schema.decodeUnknownEffect(ExecutorsConfig)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ key: path, message: error.message })),
    )
    const ids = config.executors.map((spec) => spec.id)
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    if (duplicate !== undefined) {
      return yield* Effect.fail(
        new ConfigError({ key: path, message: `duplicate executor id: ${duplicate}` }),
      )
    }
    return config.executors.flatMap((spec) => {
      const built = buildExecutor(spec, deps)
      return built === undefined ? [] : [built]
    })
  })
