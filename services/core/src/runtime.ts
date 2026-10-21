import { type Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { GhClientLive } from "@shoalwork/currents"
import { makeDbLayer } from "@shoalwork/db"
import {
  CHAT_ID,
  ChatSessionsLive,
  defaultChatMapTier,
  loadQuotaConfig,
  type QuotaConfig,
  QuotaStoreLive,
  type TierConfig,
  tierMappingFrom,
} from "@shoalwork/executors"
import { FactoryScheduler, FactorySchedulerLive, KanbanLive } from "@shoalwork/factory"
import {
  ApprovalFlowLive,
  type ConsolidateHookOptions,
  Conversation,
  ConversationLive,
  executorConsolidationModel,
  type IndexHookOptions,
  Lead,
  LeadLive,
  loadContextConfig,
  McpTokensLive,
  Planning,
  PlanningLive,
  PodNotesLive,
  startConsolidateHook,
  startIndexHook,
  TaskStoreLive,
} from "@shoalwork/lead"
import { makeApprovalsLive, makePolicyLive, UNRESOLVED_POLICY } from "@shoalwork/policy"
import { EmbedderOllamaLive, IndexerLive, Ranker, RankerLive, ReefLive, runRankTune } from "@shoalwork/reef"
import { loadReflexConfig, makeReflexLive } from "@shoalwork/reflex"
import { TankLocalLive, TankServerLive } from "@shoalwork/tank"
import { startSystemTide, Tides, TidesLive } from "@shoalwork/tides"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { ApprovalDecisionsLive } from "./approvals.js"
import { AppConfig, type AppConfigShape, coreApiOrigin, hostEnvSnapshot, REPO_ROOT } from "./config.js"
import { executorsFor, RegistryFromConfig } from "./executors-compose.js"
import { loadModelTiers } from "./model-tiers.js"
import {
  PodInboundSlot,
  PodInboundSlotLive,
  TelegramFromSettings,
  TelegramStatus,
  telegramSettings,
} from "./telegram.js"
import { startWatchdog, type WatchdogConfig } from "./watchdog.js"

// What a Bot created by conversation may be given: the most it can spend, the one policy and the one Tank of the host.
const BOT_FACTORY_CEILING = { tokens: 1_000_000, seconds: 3600, usd: 10 } as const

// The Policy of the product (T-053): a Bot's rules are the file its definition names. A Bot that cannot be read gets a
// name no file has, so every call of it is asked. The only workspace root is the run's own worktree, which the Lead
// binds to the run's token (T-177); there is no standing root.
const PolicyFromBots = (config: AppConfigShape) =>
  Layer.unwrap(
    Effect.map(BotRegistry, (bots) =>
      makePolicyLive({
        policyDir: config.policyDir,
        policyOf: (botId) =>
          bots.get(botId).pipe(
            Effect.map((bot): string | undefined => bot.policy),
            Effect.orElseSucceed(() => UNRESOLVED_POLICY),
          ),
      }),
    ),
  )

const DbFromConfig = Layer.unwrap(Effect.map(AppConfig, (config) => makeDbLayer(config.databasePath)))

const PersistenceLive = Layer.mergeAll(DbFromConfig, BeaconLive.pipe(Layer.provide(DbFromConfig)))

const TankFromConfig = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.tankSudo
      ? TankServerLive({ baseEnv: hostEnvSnapshot(), sudo: true })
      : TankLocalLive({ root: config.tankRoot, baseEnv: hostEnvSnapshot() }),
  ),
)

// The quota store (T-075) is shared by the executors and the quota routes, so it sits above the database.
const DomainLive = (config: AppConfigShape, tiers: TierConfig, quotaConfig: QuotaConfig) =>
  Layer.mergeAll(
    BotRegistryLive,
    TankFromConfig,
    RegistryFromConfig(config, tiers, quotaConfig),
    KanbanLive,
  ).pipe(Layer.provideMerge(QuotaStoreLive(quotaConfig)), Layer.provideMerge(PersistenceLive))

// The tier table and the Reflex rules are read once per boot. A broken file fails this layer, so the core does not
// boot; the failure is a ConfigError (tiers) or a SchemaViolation (Reflex) naming the file.
// Everything the HTTP handlers, the Lead worker, the conversation and the memory hooks can reach.
export const AppLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const tiers = yield* loadModelTiers(config.modelTiersPath)
    // Subscription quota windows (T-075): a broken file fails the boot, like the tier table.
    const quotaConfig = yield* loadQuotaConfig(config.quotaConfigPath)
    const reflexConfig = yield* loadReflexConfig(config.reflexConfigPath)
    const telegram = yield* telegramSettings(config)
    const contextConfig = yield* loadContextConfig(config.contextConfigPath)
    const withStore = TaskStoreLive.pipe(Layer.provideMerge(DomainLive(config, tiers, quotaConfig)))
    // Execution tokens (T-167) sit under the Lead, so the Lead can issue and revoke them for each Bot run.
    const withMcpTokens = McpTokensLive.pipe(Layer.provideMerge(withStore))
    // Approvals (T-054) sit under the Lead, which records a run that needs one and resumes it once decided.
    const withApprovals = makeApprovalsLive({ ttlMs: config.approvalTtlMinutes * 60_000 }).pipe(
      Layer.provideMerge(withMcpTokens),
    )
    // The permission bridge asks this Policy (POST /policy/evaluate); it sits under the Lead like the Approvals.
    const withPolicy = PolicyFromBots(config).pipe(Layer.provideMerge(withApprovals))
    const botBudgetWindowMs = config.budgetBotWindowHours * 60 * 60 * 1000
    // No connection to Ollama until a memory is saved or searched, so the core boots without it.
    const withEmbedder = EmbedderOllamaLive({
      baseUrl: config.ollamaUrl,
      model: config.ollamaEmbedModel,
    }).pipe(Layer.provideMerge(withPolicy))
    const withReef = ReefLive().pipe(Layer.provideMerge(withEmbedder))
    // Code search for the MCP routes (T-167) and the briefing's code block (T-041). Same embedder and database as the Reef.
    // Below the Lead, so the Lead finds the Indexer in its context.
    const withIndexer = IndexerLive().pipe(Layer.provideMerge(withReef))
    // The six-signal ranker of the briefing's code block (T-096): the weights of config/context.yaml, overridden by the
    // ones the weekly rank-tune stores. Same place as the Indexer, so the Lead finds it in its context.
    const withRanker = RankerLive({ weights: contextConfig.rank?.weights }).pipe(
      Layer.provideMerge(withIndexer),
    )
    // The reef MCP server of a Bot run: its entrypoint and the origin of this core (T-168).
    // With PERMISSION_BRIDGE on, a claude-code run also gets the bridge server (inline: the CLI waits for the person).
    const mcp = {
      serverEntry: config.reefMcpEntry,
      api: coreApiOrigin(config.appUrl, config.port),
      ...(config.permissionBridge
        ? { permissionBridge: { serverEntry: config.permissionBridgeEntry, mode: "inline" as const } }
        : {}),
    }
    // gh opens the PR of a delivered code task (T-045). Host calls get an allowlisted env, never the core's full one.
    const withGh = GhClientLive({ baseEnv: hostEnvSnapshot() })
    const withLead = LeadLive(
      tiers,
      { botBudgetWindowMs, mcp, context: contextConfig },
      { maxAgentMsgsPerTask: config.maxAgentMsgsPerTask },
    ).pipe(Layer.provideMerge(withRanker), Layer.provideMerge(withGh), Layer.provideMerge(PodNotesLive))
    // Tides (T-044) create tasks through the Lead, so they sit above it: cron and event triggers of every Bot.
    const withTides = TidesLive({ botBudgetWindowMs }).pipe(Layer.provideMerge(withLead))
    // The delivery cycle (T-061) sits above the Lead, the Policy and the Approvals it asks, and the GitHub client.
    const withFactory = FactorySchedulerLive.pipe(Layer.provideMerge(withTides))
    const withReflex = makeReflexLive(reflexConfig).pipe(Layer.provideMerge(withFactory))
    const withSessions = ChatSessionsLive.pipe(Layer.provideMerge(withReflex))
    const withConsolidation = executorConsolidationModel(tiers).pipe(Layer.provideMerge(withSessions))
    // The one door for a decision: web, CLI and the Telegram buttons all go through it.
    const withApprovalFlow = ApprovalFlowLive.pipe(Layer.provideMerge(withConsolidation))
    const withDecisions = ApprovalDecisionsLive.pipe(Layer.provideMerge(withApprovalFlow))
    const withSlot = PodInboundSlotLive.pipe(Layer.provideMerge(withDecisions))
    const withTelegram = TelegramFromSettings(telegram).pipe(Layer.provideMerge(withSlot))
    // Planner -> Pod -> Dispatcher (T-175): above the Lead and the connector, whose topics the Pods use. Without
    // Telegram a Pod has no topic, and the plan runs all the same.
    const withPlanning = Layer.unwrap(
      Effect.map(TelegramStatus, (status) =>
        PlanningLive(tiers, {
          planConcurrency: config.planConcurrency,
          botBudgetWindowMs,
          topics: status.enabled ? "telegram" : "none",
        }),
      ),
    ).pipe(Layer.provideMerge(withTelegram))
    return ConversationLive(tiers, reflexConfig, {
      botBudgetWindowMs,
      warm: { mapTier: tierMappingFrom(tiers, CHAT_ID, defaultChatMapTier) },
      botFactory: {
        botsDir: `${REPO_ROOT}bots`,
        // The chat adapter only answers conversation turns: a Bot never runs on it.
        // Only the ids are read here: the store is not needed, the registry above shares the real one.
        executors: executorsFor({ config, tiers, quotaConfig, quota: undefined })
          .map((executor) => executor.id)
          .filter((id) => id !== CHAT_ID),
        config: { ceiling: BOT_FACTORY_CEILING, policy: "default", tank: { mode: "local", host: "mac" } },
      },
    }).pipe(Layer.provideMerge(withPlanning))
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
      const planning = yield* Planning
      // The Pod topics' messages and the plan steps' narration meet the Pods here, once they exist.
      const slot = yield* PodInboundSlot
      slot.bind(planning.onHumanMessage)
      yield* planning.start
      yield* lead.startWorker({ ...options, runTask: planning.run })
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

// Repo indexing of finished and first-run code tasks, in its own fiber like the consolidation (T-170).
export const startIndexFiber = (options: IndexHookOptions) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      yield* startIndexHook(options)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// Sundays at 04:00 UTC.
export const RANK_TUNE_CRON = "0 4 * * 0"

// The weekly rank-tune (T-096) in its own fiber, as a system tide: tunes the ranking weights on the last briefings and
// records context.weights_updated. The config weights (or the stored ones) are where the tuning starts from.
export const startRankTuneFiber = (options: { readonly pollMs: number }) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const ranker = yield* Ranker
      const context = yield* Effect.context<SqlClient | Beacon>()
      yield* startSystemTide(sql, {
        name: "rank-tune",
        expr: RANK_TUNE_CRON,
        pollMs: options.pollMs,
        run: Effect.flatMap(ranker.weights(), (weights) => runRankTune(weights)).pipe(
          Effect.provide(context),
        ),
      })
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// Cron and event triggers (T-044) in their own fiber; the cron window is checked every pollMs.
export const startTidesFiber = (options: { readonly pollMs: number }) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      const tides = yield* Tides
      yield* tides.startScheduler(options)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

// The factory's loop (30 s plus the events that wake it) in its own fiber, like the Tides.
export const startFactoryFiber = (options: { readonly pollMs: number }) =>
  appRuntime.runFork(
    Effect.gen(function* () {
      const scheduler = yield* FactoryScheduler
      yield* scheduler.start(options)
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )

export const disposeRuntime = (): Promise<void> => appRuntime.dispose()
