import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { BotRegistry } from "@shoalwork/bots"
import { runMigrations } from "@shoalwork/db"
import { Control } from "@shoalwork/lead"
import { loadReflexConfig } from "@shoalwork/reflex"
import { Tides } from "@shoalwork/tides"
import { Data, Effect, Fiber, type LogLevel, type Redacted, References } from "effect"
import { AppConfig, type AppConfigShape, REPO_ROOT } from "./config.js"
import { makeApp } from "./http/app.js"
import { serve } from "./http/serve.js"
import { loadModelTiers } from "./model-tiers.js"
import {
  disposeRuntime,
  runEffect,
  startConsolidateFiber,
  startConversationFiber,
  startIndexFiber,
  startLeadWorker,
  startTidesFiber,
  startWatchdogFiber,
} from "./runtime.js"
import { telegramSettings } from "./telegram.js"
import type { WatchdogConfig } from "./watchdog.js"

class BootError extends Data.TaggedError("BootError")<{
  readonly step: string
  readonly cause: unknown
}> {}

// tsx does not read .env, and pnpm runs scripts from services/core. Both paths point at the repo-root .env.
const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url))

// Bot definitions are read from the repo's bots/ directory, whatever the cwd is.
const BOTS_DIR = `${REPO_ROOT}bots`

const loadDotEnv = (): void => {
  try {
    process.loadEnvFile?.(REPO_ENV_FILE)
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
      throw cause
    }
  }
}

// Watchdog cadence (02-architecture §11): every five minutes.
const WATCHDOG_INTERVAL_MS = 300_000

const LOG_LEVELS: Record<"debug" | "info" | "warn" | "error", LogLevel.LogLevel> = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
}

const syncBots = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.syncFromDir(BOTS_DIR)
})

// Tides come from the bot files, after the bots exist (their ids are the registry's): upserted by (bot, name).
const syncTides = Effect.gen(function* () {
  const tides = yield* Tides
  return yield* tides.syncFromDir(BOTS_DIR)
})

// Tide cadence (02-architecture §11): the cron windows are checked every 30 seconds.
const TIDES_POLL_MS = 30_000

const recoverOrphans = Effect.gen(function* () {
  const control = yield* Control
  return yield* control.recoverOrphans()
})

// Finalizers run in reverse order: the HTTP server closes first, then the Lead worker, then the database runtime.
const serveUntilInterrupted = (
  port: number,
  apiToken: Redacted.Redacted<string>,
  settings: Pick<
    AppConfigShape,
    | "modelTiersPath"
    | "reflexConfigPath"
    | "telegramBotToken"
    | "telegramAllowedUserIds"
    | "telegramForumChatId"
  >,
  watchdog: WatchdogConfig,
) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => disposeRuntime()).pipe(
        Effect.andThen(Effect.logInfo("shutdown: database closed")),
      ),
    )
    // A broken tier table stops the boot here, under its own step name (the file is read again when the layer builds).
    yield* loadModelTiers(settings.modelTiersPath).pipe(
      Effect.mapError((cause) => new BootError({ step: "model-tiers", cause })),
    )
    // Same for the Reflex rules and for an incomplete Telegram setup (a token without allowlist or forum chat).
    yield* loadReflexConfig(settings.reflexConfigPath).pipe(
      Effect.mapError((cause) => new BootError({ step: "reflex-config", cause })),
    )
    const telegram = yield* telegramSettings(settings).pipe(
      Effect.mapError((cause) => new BootError({ step: "telegram", cause })),
    )
    yield* Effect.logInfo(telegram === undefined ? "telegram: off (no token)" : "telegram: on")
    const applied = yield* Effect.tryPromise({
      try: () => runEffect(runMigrations),
      catch: (cause) => new BootError({ step: "migrations", cause }),
    })
    yield* Effect.logInfo(`migrations applied: ${applied.length}`)
    // Tasks left `running` by the previous process are closed before any worker can claim work.
    const orphans = yield* Effect.tryPromise({
      try: () => runEffect(recoverOrphans),
      catch: (cause) => new BootError({ step: "orphans", cause }),
    })
    yield* Effect.logInfo(
      `orphan tasks after restart: ${orphans.resumed.length} resumed, ${orphans.failed.length} failed`,
    )
    const bots = yield* Effect.tryPromise({
      try: () => runEffect(syncBots),
      catch: (cause) => new BootError({ step: "bots", cause }),
    })
    yield* Effect.logInfo(`bots synced: ${bots.length}`)
    const tides = yield* Effect.tryPromise({
      try: () => runEffect(syncTides),
      catch: (cause) => new BootError({ step: "tides", cause }),
    })
    yield* Effect.logInfo(`tides synced: ${tides.length}`)
    const scheduling = startTidesFiber({ pollMs: TIDES_POLL_MS })
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(scheduling).pipe(Effect.andThen(Effect.logInfo("shutdown: tides stopped"))),
    )
    const worker = startLeadWorker({ concurrency: 2, pollMs: 1000 })
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(worker).pipe(Effect.andThen(Effect.logInfo("shutdown: lead worker stopped"))),
    )
    const recovery = startWatchdogFiber(watchdog)
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(recovery).pipe(Effect.andThen(Effect.logInfo("shutdown: watchdog stopped"))),
    )
    const consolidation = startConsolidateFiber({ pollMs: 1000, heartbeatMs: 30_000 })
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(consolidation).pipe(Effect.andThen(Effect.logInfo("shutdown: consolidation stopped"))),
    )
    const indexing = startIndexFiber({ pollMs: 1000, heartbeatMs: 30_000 })
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(indexing).pipe(Effect.andThen(Effect.logInfo("shutdown: indexing stopped"))),
    )
    // Without TELEGRAM_BOT_TOKEN this fiber ends at once (the Telegram layer is a no-op).
    const conversation = startConversationFiber()
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(conversation).pipe(Effect.andThen(Effect.logInfo("shutdown: conversation stopped"))),
    )
    yield* serve(makeApp({ apiToken, runEffect, runMemory: runEffect, runMcp: runEffect }), port)
    yield* Effect.logInfo(`listening on port ${port}`)
    yield* Effect.never
  }).pipe(Effect.scoped)

const main = Effect.gen(function* () {
  const config = yield* AppConfig
  const watchdog: WatchdogConfig = {
    intervalMs: WATCHDOG_INTERVAL_MS,
    staleMinutes: config.watchdogStaleMinutes,
    maxProcessMinutes: config.watchdogMaxProcessMinutes,
  }
  return yield* serveUntilInterrupted(config.port, config.apiToken, config, watchdog).pipe(
    Effect.provideService(References.MinimumLogLevel, LOG_LEVELS[config.logLevel]),
  )
})

loadDotEnv()
NodeRuntime.runMain(main)
