import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { runMigrations } from "@shoalwork/db"
import { Data, Effect, type LogLevel, type Redacted, References } from "effect"
import { AppConfig } from "./config.js"
import { makeApp } from "./http/app.js"
import { serve } from "./http/serve.js"
import { disposeRuntime, runEffect } from "./runtime.js"

class BootError extends Data.TaggedError("BootError")<{
  readonly step: string
  readonly cause: unknown
}> {}

// tsx does not read .env, and pnpm runs scripts from services/core. Both paths point at the repo-root .env.
const REPO_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url))

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

// Finalizers run in reverse order: the HTTP server closes first, then the database runtime.
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
