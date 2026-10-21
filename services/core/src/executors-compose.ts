import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { ExecutorId } from "@shoalwork/contracts"
import {
  CHAT_ID,
  CODEX_ID,
  defaultChatMapTier,
  defaultMapTier,
  type Executor,
  type ExecutorRegistry,
  makeClaudeCode,
  makeClaudeCodeChat,
  makeCodexExecutor,
  makeRegistry,
  type QuotaConfig,
  QuotaStore,
  type QuotaStoreShape,
  type TierConfig,
  tierMappingFrom,
  WINDOW_MS,
} from "@shoalwork/executors"
import { Effect, Layer, Schema } from "effect"
import { acpExecutors } from "./acp-executors.js"
import type { AppConfigShape } from "./config.js"
import { hostEnvSnapshot } from "./config.js"
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

const CLAUDE_CODE_ID = Schema.decodeUnknownSync(ExecutorId)("claude-code")

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
// need the ids alone.
export type ExecutorsInput = {
  readonly config: Pick<AppConfigShape, "permissionBridge" | "codexModel">
  readonly tiers: TierConfig
  readonly quotaConfig: QuotaConfig
  readonly quota: QuotaStoreShape | undefined
  readonly onPath?: (bin: string) => boolean
}

// Each adapter takes its model per tier from the tier table; tiers served by another executor keep the adapter's
// built-in mapping. codex is registered only when the binary exists on this host (ADR-011: no API keys).
export const executorsFor = (input: ExecutorsInput): ReadonlyArray<Executor> => {
  const { config, tiers, quotaConfig, quota } = input
  const onPath = input.onPath ?? ((bin: string) => findOnPath(bin, hostEnvSnapshot().PATH))
  const models = codexModelsFrom(tiers, config.codexModel)
  const legacy = legacyLimitOf(quotaConfig)
  const store = quota === undefined ? {} : { quota }
  const codex = onPath("codex")
    ? [
        makeCodexExecutor({
          quotaWindowSeconds: legacy.windowSeconds,
          quotaSoftLimitTokens: legacy.softLimitTokens,
          ...store,
          ...(models === undefined ? {} : { models }),
        }),
      ]
    : []
  const acp = acpExecutors({
    onPath,
    quotaWindowSeconds: legacy.windowSeconds,
    quotaSoftLimitTokens: legacy.softLimitTokens,
  })
  return [
    makeClaudeCode({
      mapTier: tierMappingFrom(tiers, CLAUDE_CODE_ID, defaultMapTier),
      permissionBridge: config.permissionBridge,
      ...store,
    }),
    makeClaudeCodeChat({ mapTier: tierMappingFrom(tiers, CHAT_ID, defaultChatMapTier) }),
    ...codex,
    ...acp,
  ]
}

// The registry of this host. It needs the shared quota store, so it is built on top of QuotaStore: the adapters and the
// quota routes read the same instance.
export const RegistryFromConfig = (
  config: ExecutorsInput["config"],
  tiers: TierConfig,
  quotaConfig: QuotaConfig,
): Layer.Layer<ExecutorRegistry, never, QuotaStore> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const quota = yield* QuotaStore
      return makeRegistry(executorsFor({ config, tiers, quotaConfig, quota }))
    }),
  )
