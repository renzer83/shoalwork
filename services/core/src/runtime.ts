import { BeaconLive } from "@shoalwork/beacon"
import { makeDbLayer } from "@shoalwork/db"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppConfig } from "./config.js"

// Built from the resolved path in AppConfig (not DbLive, which reads DATABASE_PATH unresolved).
const DbFromConfig = Layer.unwrap(Effect.map(AppConfig, (config) => makeDbLayer(config.databasePath)))

export const AppLayer = Layer.mergeAll(DbFromConfig, BeaconLive.pipe(Layer.provide(DbFromConfig)))
export type AppServices = Layer.Success<typeof AppLayer>

// Built lazily on first use, so env is read only after main() has loaded .env.
const appRuntime = ManagedRuntime.make(AppLayer)

export const runEffect = <A, E>(eff: Effect.Effect<A, E, AppServices>): Promise<A> =>
  appRuntime.runPromise(eff)

export const disposeRuntime = (): Promise<void> => appRuntime.dispose()
