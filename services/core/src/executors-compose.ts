import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import type { ConfigError } from "@shoalwork/contracts"
import {
  CHAT_ID,
  CODEX_ID,
  defaultChatMapTier,
  type Executor,
  type ExecutorRegistry,
  type ExecutorsConfigDeps,
  loadExecutorsConfig,
  makeClaudeCodeChat,
  makeRegistry,
  type OpenAICompatPolicy,
  type QuotaConfig,
  QuotaStore,
  type QuotaStoreShape,
  type TierConfig,
  tierMappingFrom,
  WINDOW_MS,
} from "@shoalwork/executors"
import { Policy } from "@shoalwork/policy"
import { Effect, Layer, Option, Result } from "effect"
import { acpExecutors } from "./acp-executors.js"
import type { AppConfigShape } from "./config.js"
import { hostEnvSnapshot, resolveRepoPath } from "./config.js"
import { codexModelsFrom } from "./model-tiers.js"

// `which` without a shell: walks PATH and checks the execute bit. A lookup failure just means "not installed".
const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const findOnPath = (name: string, pathValue: string | undefined): boolean =>
  (pathValue ?? "")
    .split(":")
    .filter((dir) => dir !== "")
    .some((dir) => isExecutable(join(dir, name)))

// The legacy counters (the acp adapters, and codex when it has no store) take a window and a soft limit. Both come
// from config/quotas.yaml, the one source of quota numbers: the codex 5h window. With no such window there is no
// limit to count against.
export const legacyLimitOf = (
  quotaConfig: QuotaConfig,
): { readonly windowSeconds: number; readonly softLimitTokens: number } => {
  const fiveHour = quotaConfig.executors[CODEX_ID]?.windows.find((window) => window.kind === "5h")
  return {
    windowSeconds: WINDOW_MS["5h"] / 1000,
    softLimitTokens: fiveHour?.soft_tokens ?? Number.MAX_SAFE_INTEGER,
  }
}

// What the executors are built from. `quota` is the shared store; the chat-only callers pass undefined because they
// need the ids alone. `executorsConfigPath` is config/executors.yaml (EXECUTORS_CONFIG_PATH).
export type ExecutorsInput = {
  readonly config: Pick<AppConfigShape, "permissionBridge" | "codexModel"> & {
    readonly executorsConfigPath?: string
  }
  readonly tiers: TierConfig
  readonly quotaConfig: QuotaConfig
  readonly quota: QuotaStoreShape | undefined
  readonly onPath?: (bin: string) => boolean
}

// Callers that do not set the path (the tests) read the shipped file, anchored to the repo root like the config.
const DEFAULT_EXECUTORS_CONFIG = resolveRepoPath("config/executors.yaml")
const configPathOf = (input: ExecutorsInput): string =>
  input.config.executorsConfigPath ?? DEFAULT_EXECUTORS_CONFIG

const onPathOf = (input: ExecutorsInput): ((bin: string) => boolean) =>
  input.onPath ?? ((bin: string) => findOnPath(bin, hostEnvSnapshot().PATH))

// The Policy of the Bot for tool calls of the openai-compat instances: the same rule as the ACP adapters' (acp-executors.ts),
// stated here so that module keeps only the ACP wiring. Without the service the call is asked, never pre-approved.
const botPolicy: OpenAICompatPolicy = (botId, call, context) =>
  Effect.serviceOption(Policy).pipe(
    Effect.flatMap((policy) =>
      Option.isSome(policy)
        ? policy.value.evaluate(botId, call, context)
        : Effect.succeed({ effect: "ask", risk: "external" } as const),
    ),
  )

// The inputs of the instances of config/executors.yaml. The env is the core's; the loader reads only its allowlist.
const depsOf = (input: ExecutorsInput): ExecutorsConfigDeps => {
  const legacy = legacyLimitOf(input.quotaConfig)
  return {
    env: hostEnvSnapshot(),
    onPath: onPathOf(input),
    tiers: input.tiers,
    quota: input.quota,
    permissionBridge: input.config.permissionBridge,
    codexModels: codexModelsFrom(input.tiers, input.config.codexModel),
    codexCounter: { windowSeconds: legacy.windowSeconds, softLimitTokens: legacy.softLimitTokens },
    policy: botPolicy,
  }
}

// Executors the code composes itself: the conversation's chat adapter (never a Bot's) and the ACP agents, which are
// registered only when their binary is on this host (ADR-011: no API keys).
const composedExecutors = (input: ExecutorsInput): ReadonlyArray<Executor> => {
  const legacy = legacyLimitOf(input.quotaConfig)
  return [
    makeClaudeCodeChat({ mapTier: tierMappingFrom(input.tiers, CHAT_ID, defaultChatMapTier) }),
    ...acpExecutors({
      onPath: onPathOf(input),
      quotaWindowSeconds: legacy.windowSeconds,
      quotaSoftLimitTokens: legacy.softLimitTokens,
    }),
  ]
}

// Every executor id this host has, as the boot sees them. The instances of executors.yaml are read synchronously here,
// so the id list the Bot factory gets is the same as the registry's. A broken file yields only the composed ids:
// RegistryFromConfig then fails the boot with the ConfigError, which is the one place that reports it.
export const executorsFor = (input: ExecutorsInput): ReadonlyArray<Executor> => {
  const configured = Effect.runSync(Effect.result(loadExecutorsConfig(configPathOf(input), depsOf(input))))
  return [...(Result.isSuccess(configured) ? configured.success : []), ...composedExecutors(input)]
}

// The registry of this host. It needs the shared quota store, so it is built on top of QuotaStore: the adapters and the
// quota routes read the same instance. A broken executors.yaml fails the layer with a ConfigError naming the file.
export const RegistryFromConfig = (
  config: ExecutorsInput["config"],
  tiers: TierConfig,
  quotaConfig: QuotaConfig,
): Layer.Layer<ExecutorRegistry, ConfigError, QuotaStore> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const quota = yield* QuotaStore
      const input: ExecutorsInput = { config, tiers, quotaConfig, quota }
      const configured = yield* loadExecutorsConfig(configPathOf(input), depsOf(input))
      return makeRegistry([...configured, ...composedExecutors(input)])
    }),
  )
