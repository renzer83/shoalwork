import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { makeDbLayer } from "@shoalwork/db"
import {
  type Executor,
  makeClaudeCode,
  makeClaudeCodeChat,
  makeCodexExecutor,
  makeRegistry,
} from "@shoalwork/executors"
import { Lead, LeadWithStore } from "@shoalwork/lead"
import { TankLocalLive, TankServerLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppConfig, type AppConfigShape, hostEnvSnapshot } from "./config.js"

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

// codex is registered only when the binary exists on this host (ADR-011: no API keys for any executor).
const executorsFor = (config: AppConfigShape): ReadonlyArray<Executor> => {
  const model = config.codexModel
  const models =
    model === undefined ? undefined : { chat: model, decision: model, light: model, heavy: model }
  const codex = findOnPath("codex", hostEnvSnapshot().PATH)
    ? [
        makeCodexExecutor({
          quotaWindowSeconds: config.codexQuotaWindowSeconds,
          quotaSoftLimitTokens: config.codexQuotaSoftLimitTokens,
          ...(models === undefined ? {} : { models }),
        }),
      ]
    : []
  return [makeClaudeCode(), makeClaudeCodeChat(), ...codex]
}

const DbFromConfig = Layer.unwrap(Effect.map(AppConfig, (config) => makeDbLayer(config.databasePath)))

const PersistenceLive = Layer.mergeAll(DbFromConfig, BeaconLive.pipe(Layer.provide(DbFromConfig)))

const TankFromConfig = Layer.unwrap(
  Effect.map(AppConfig, (config) =>
    config.tankSudo
      ? TankServerLive({ baseEnv: hostEnvSnapshot(), sudo: true })
      : TankLocalLive({ root: config.tankRoot, baseEnv: hostEnvSnapshot() }),
  ),
)

const ExecutorsFromConfig = Layer.unwrap(
  Effect.map(AppConfig, (config) => makeRegistry(executorsFor(config))),
)

const DomainLive = Layer.mergeAll(BotRegistryLive, TankFromConfig, ExecutorsFromConfig).pipe(
  Layer.provideMerge(PersistenceLive),
)

// Everything the HTTP handlers and the Lead worker can reach. Outputs include SqlClient, Beacon, Lead and the rest.
export const AppLayer = LeadWithStore().pipe(Layer.provideMerge(DomainLive))
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

export const disposeRuntime = (): Promise<void> => appRuntime.dispose()
