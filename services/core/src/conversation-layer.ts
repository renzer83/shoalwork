import {
  CHAT_ID,
  defaultChatMapTier,
  type QuotaConfig,
  type TierConfig,
  tierMappingFrom,
} from "@shoalwork/executors"
import { ConversationLive } from "@shoalwork/lead"
import type { ReflexConfig } from "@shoalwork/reflex"
import { Effect, Layer } from "effect"
import { type AppConfigShape, REPO_ROOT } from "./config.js"
import { executorsFor } from "./executors-compose.js"
import { TelegramStatus } from "./telegram.js"

// What a Bot created by conversation may be given: the most it can spend, the one policy and the one Tank of the host.
const BOT_FACTORY_CEILING = { tokens: 1_000_000, seconds: 3600, usd: 10 } as const

export interface ConversationLayerInput {
  readonly config: AppConfigShape
  readonly tiers: TierConfig
  readonly quotaConfig: QuotaConfig
  readonly reflexConfig: ReflexConfig
  readonly botBudgetWindowMs: number
}

// The conversation answers the app channel (T-189) whether or not the Telegram connector runs; it learns which from
// TelegramStatus, so that with Telegram off it creates no topics and sends no cards there.
export const ConversationFromCore = (input: ConversationLayerInput) =>
  Layer.unwrap(
    Effect.map(TelegramStatus, (status) =>
      ConversationLive(input.tiers, input.reflexConfig, {
        telegram: status.enabled,
        botBudgetWindowMs: input.botBudgetWindowMs,
        warm: { mapTier: tierMappingFrom(input.tiers, CHAT_ID, defaultChatMapTier) },
        botFactory: {
          botsDir: `${REPO_ROOT}bots`,
          // The chat adapter only answers conversation turns: a Bot never runs on it.
          // Only the ids are read here: the store is not needed, the registry above shares the real one.
          executors: executorsFor({
            config: input.config,
            tiers: input.tiers,
            quotaConfig: input.quotaConfig,
            quota: undefined,
          })
            .map((executor) => executor.id)
            .filter((id) => id !== CHAT_ID),
          config: { ceiling: BOT_FACTORY_CEILING, policy: "default", tank: { mode: "local", host: "mac" } },
        },
      }),
    ),
  )
