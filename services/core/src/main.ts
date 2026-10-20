import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { BotRegistry } from "@shoalwork/bots"
import { runMigrations } from "@shoalwork/db"
import { Data, Effect, Fiber, type LogLevel, type Redacted, References } from "effect"
import { AppConfig, REPO_ROOT } from "./config.js"
import { makeApp } from "./http/app.js"
import { serve } from "./http/serve.js"
import { disposeRuntime, runEffect, startLeadWorker } from "./runtime.js"

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

// Finalizers run in reverse order: the HTTP server closes first, then the Lead worker, then the database runtime.
const serveUntilInterrupted = (port: number, apiToken: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => disposeRuntime()).pipe(
        Effect.andThen(Effect.logInfo("shutdown: database closed")),
      ),
    )
    const applied = yield* Effect.tryPromise({
      try: () => runEffect(runMigrations),
      catch: (cause) => new BootError({ step: "migrations", cause }),
    })
    yield* Effect.logInfo(`migrations applied: ${applied.length}`)
    const bots = yield* Effect.tryPromise({
      try: () => runEffect(syncBots),
      catch: (cause) => new BootError({ step: "bots", cause }),
    })
    yield* Effect.logInfo(`bots synced: ${bots.length}`)
    const worker = startLeadWorker({ concurrency: 2, pollMs: 1000 })
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(worker).pipe(Effect.andThen(Effect.logInfo("shutdown: lead worker stopped"))),
    )
    yield* serve(makeApp({ apiToken, runEffect }), port)
    yield* Effect.logInfo(`listening on port ${port}`)
    yield* Effect.never
  }).pipe(Effect.scoped)

const main = Effect.gen(function* () {
  const config = yield* AppConfig
  return yield* serveUntilInterrupted(config.port, config.apiToken).pipe(
    Effect.provideService(References.MinimumLogLevel, LOG_LEVELS[config.logLevel]),
  )
})

loadDotEnv()
NodeRuntime.runMain(main)
