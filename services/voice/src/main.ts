import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { VoiceConfig } from "./config.js"
import { makeVoiceSidecars, VoiceSidecars } from "./sidecars.js"

// Pipeline (capture, wake word, turns) enters in T-106; for now the process only keeps the sidecars up.
const program = Effect.gen(function* () {
  const sidecars = yield* VoiceSidecars
  yield* sidecars.start()
  const health = yield* sidecars.health()
  yield* Effect.logInfo(
    `voice: stt=${health.stt ? "ready" : "unavailable"} tts=${health.tts ? "ready" : "unavailable"}`,
  )
  yield* Effect.never
})

const main = Effect.gen(function* () {
  const config = yield* VoiceConfig
  return yield* program.pipe(Effect.provide(Layer.succeed(VoiceSidecars, makeVoiceSidecars(config))))
}).pipe(Effect.scoped)

NodeRuntime.runMain(main)
