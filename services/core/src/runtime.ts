import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { ExecutorId } from "@shoalwork/contracts"
import { makeDbLayer } from "@shoalwork/db"
import {
  CHAT_ID,
  ChatSessionsLive,
  defaultChatMapTier,
  defaultMapTier,
  type Executor,
  makeClaudeCode,
  makeClaudeCodeChat,
  makeCodexExecutor,
  makeRegistry,
  type TierConfig,
  tierMappingFrom,
} from "@shoalwork/executors"
import {
  type ConsolidateHookOptions,
  Conversation,
  ConversationLive,
  executorConsolidationModel,
  Lead,
  LeadLive,
  startConsolidateHook,
  TaskStoreLive,
} from "@shoalwork/lead"
import { EmbedderOllamaLive, ReefLive } from "@shoalwork/reef"
import { loadReflexConfig, makeReflexLive } from "@shoalwork/reflex"
import { TankLocalLive, TankServerLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { AppConfig, type AppConfigShape, hostEnvSnapshot, REPO_ROOT } from "./config.js"
import { codexModelsFrom, loadModelTiers } from "./model-tiers.js"
import { TelegramFromSettings, TelegramStatus, telegramSettings } from "./telegram.js"
import { startWatchdog, type WatchdogConfig } from "./watchdog.js"

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

// Each adapter takes its model per tier from the tier table; tiers served by another executor keep the adapter's
// built-in mapping. codex is registered only when the binary exists on this host (ADR-011: no API keys).
const executorsFor = (config: AppConfigShape, tiers: TierConfig): ReadonlyArray<Executor> => {
  const models = codexModelsFrom(tiers, config.codexModel)
  const codex = findOnPath("codex", hostEnvSnapshot().PATH)
    ? [
        makeCodexExecutor({
          quotaWindowSeconds: config.codexQuotaWindowSeconds,
          quotaSoftLimitTokens: config.codexQuotaSoftLimitTokens,
          ...(models === undefined ? {} : { models }),
        }),
      ]
    : []
  return [
    makeClaudeCode({ mapTier: tierMappingFrom(tiers, CLAUDE_CODE_ID, defaultMapTier) }),
    makeClaudeCodeChat({ mapTier: tierMappingFrom(tiers, CHAT_ID, defaultChatMapTier) }),
    ...codex,
  ]
}

// What a Bot created by conversation may be given: the most it can spend, the one policy and the one Tank of the host.
const BOT_FACTORY_CEILING = { tokens: 1_000_000, seconds: 3600, usd: 10 } as const

const DbFromConfig = Layer.unwrap(Effect.map(AppConfig, (config) => makeDbLayer(config.databasePath)))

const PersistenceLive = Layer.mergeAll(DbFromConfig, BeaconLive.pipe(Layer.provide(DbFromConfig)))

const TankFromConfig = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.tankSudo
      ? TankServerLive({ baseEnv: hostEnvSnapshot(), sudo: true })
      : TankLocalLive({ root: config.tankRoot, baseEnv: hostEnvSnapshot() }),
  ),
)

const DomainLive = (config: AppConfigShape, tiers: TierConfig) =>
  Layer.mergeAll(BotRegistryLive, TankFromConfig, makeRegistry(executorsFor(config, tiers))).pipe(
    Layer.provideMerge(PersistenceLive),
  )

// The tier table and the Reflex rules are read once per boot. A broken file fails this layer, so the core does not
// boot; the failure is a ConfigError (tiers) or a SchemaViolation (Reflex) naming the file.
// Everything the HTTP handlers, the Lead worker, the conversation and the memory hooks can reach.
export const AppLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const tiers = yield* loadModelTiers(config.modelTiersPath)
    const reflexConfig = yield* loadReflexConfig(config.reflexConfigPath)
    const telegram = yield* telegramSettings(config)
    const withStore = TaskStoreLive.pipe(Layer.provideMerge(DomainLive(config, tiers)))
    const withLead = LeadLive(tiers).pipe(Layer.provideMerge(withStore))
    const withReflex = makeReflexLive(reflexConfig).pipe(Layer.provideMerge(withLead))
    const withSessions = ChatSessionsLive.pipe(Layer.provideMerge(withReflex))
    // No connection to Ollama until a memory is saved or searched, so the core boots without it.
    const withEmbedder = EmbedderOllamaLive({
      baseUrl: config.ollamaUrl,
      model: config.ollamaEmbedModel,
    }).pipe(Layer.provideMerge(withSessions))
    const withReef = ReefLive().pipe(Layer.provideMerge(withEmbedder))
    const withConsolidation = executorConsolidationModel(tiers).pipe(Layer.provideMerge(withReef))
    const withTelegram = TelegramFromSettings(telegram).pipe(Layer.provideMerge(withConsolidation))
    return ConversationLive(tiers, reflexConfig, {
      warm: { mapTier: tierMappingFrom(tiers, CHAT_ID, defaultChatMapTier) },
      botFactory: {
        botsDir: `${REPO_ROOT}bots`,
        // The chat adapter only answers conversation turns: a Bot never runs on it.
        executors: executorsFor(config, tiers)
          .map((executor) => executor.id)
          .filter((id) => id !== CHAT_ID),
        config: { ceiling: BOT_FACTORY_CEILING, policy: "default", tank: { mode: "local", host: "mac" } },
      },
    }).pipe(Layer.provideMerge(withTelegram))
  }),
)
export type AppServices = Layer.Success<typeof AppLayer>

// Built lazily on first use, so env is read only after main() has loaded .env.
const appRuntime = ManagedRuntime.make(AppLayer)

export const runEffect = <A, E>(eff: Effect.Effect<A, E, AppServices>): Promise<A> =>
  appRuntime.runPromise(eff)

// The worker lives in its own fiber; the caller interrupts it before disposing the runtime.
export const startLeadWorker = (options: { readonly concurrency: number; readonly pollMs: number }) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      const lead = yield* Lead
      yield* lead.startWorker(options)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// The watchdog runs in its own fiber, like the worker; the caller interrupts it before disposing the runtime.
export const startWatchdogFiber = (config: WatchdogConfig) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      yield* startWatchdog(config)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// The conversation (inbound messages and task narration) runs in its own fiber. Resolves to undefined when Telegram is off.
export const startConversationFiber = () =>
  appRuntime.runFork(
    Effect.gen(function* () {
      const status = yield* TelegramStatus
      if (!status.enabled) {
        return
      }
      const conversation = yield* Conversation
      yield* conversation.start
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// Memory consolidation of finished tasks, in its own fiber like the worker.
export const startConsolidateFiber = (options: ConsolidateHookOptions) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      yield* startConsolidateHook(options)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

export const disposeRuntime = (): Promise<void> => appRuntime.dispose()
