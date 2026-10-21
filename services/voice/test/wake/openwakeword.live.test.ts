import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeCapture } from "../../src/audio/capture.js"
import { makeWakeWord } from "../../src/wake/openwakeword.js"

// Manual check (LIVE=1): needs a microphone, sox, the venv of python/ and the model files (openWakeWord download).
// Say the wake word after the run starts; the detection must arrive within the timeout. Record the latency in STATE.md.
const pythonRoot = join(import.meta.dirname, "..", "..", "python")
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }

describe.skipIf(process.env.LIVE !== "1")("WakeWord live", () => {
  it.live("detects the wake word from the microphone", () =>
    Effect.gen(function* () {
      const wake = makeWakeWord(makeCapture({ env }), {
        command: join(pythonRoot, ".venv", "bin", "python"),
        script: join(pythonRoot, "wake_server.py"),
        cwd: pythonRoot,
        model: process.env.WAKE_MODEL ?? "hey_jarvis",
        threshold: 0.5,
        env,
      })

      const first = yield* Stream.runHead(wake.detections()).pipe(Effect.timeout(30_000))

      expect(first._tag).toBe("Some")
    }),
  )
})
