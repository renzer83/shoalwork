import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { describe, expect } from "vitest"
import type { VoiceConfigShape } from "../src/config.js"
import { makeVoiceSidecars } from "../src/sidecars.js"

const appVoice = join(homedir(), ".app", "voice")
const config: VoiceConfigShape = {
  sttUrl: Option.none(),
  ttsUrl: Option.none(),
  whisperBin: join(appVoice, "whisper.cpp", "build", "bin", "whisper-server"),
  whisperModel: join(appVoice, "whisper.cpp", "models", "ggml-large-v3-turbo.bin"),
  kokoroDir: join(appVoice, "kokoro"),
  langDefault: "pt",
  ttsCommand: join(new URL("../python/.venv/bin/uvicorn", import.meta.url).pathname),
  ttsCwd: new URL("../python", import.meta.url).pathname,
  childEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() },
}

// Needs the real binaries and model files under ~/.app/voice (task pre-conditions). Runs only with LIVE=1.
describe.runIf(process.env.LIVE === "1")("VoiceSidecars against the real sidecars", () => {
  it.live("transcribes the Portuguese fixture", () =>
    Effect.gen(function* () {
      const sidecars = makeVoiceSidecars(config)
      yield* sidecars.start()
      const pcm = new Uint8Array(readFileSync(new URL("./fixtures/ola-mundo-16k.pcm", import.meta.url)))

      const response = yield* sidecars.transcribe({ pcm16k: pcm })

      expect(response.text.toLowerCase()).toContain("olá")
    }).pipe(Effect.scoped),
  )

  it.live("synthesizes at least 10 KB of PCM for a Portuguese sentence", () =>
    Effect.gen(function* () {
      const sidecars = makeVoiceSidecars(config)
      yield* sidecars.start()
      // Without this check the macOS `say` fallback could answer and hide a broken sidecar.
      expect((yield* sidecars.health()).tts).toBe(true)

      const chunks = yield* Stream.runCollect(sidecars.synthesize({ text: "teste", language: "pt" }))

      const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0)
      expect(bytes).toBeGreaterThanOrEqual(10_240)
    }).pipe(Effect.scoped),
  )
})
