import { homedir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeCapture } from "../../src/audio/capture.js"
import { DEFAULT_SEGMENT_CONFIG, segment } from "../../src/vad/segmenter.js"
import { acquireSileroSession, makeSileroVad } from "../../src/vad/silero.js"

const model =
  process.env.SILERO_MODEL?.trim() || join(homedir(), ".app", "voice", "silero", "silero_vad.onnx")

// Needs sox (`rec`), a microphone with permission, and the Silero model (task pre-conditions). Runs only with LIVE=1.
describe.runIf(process.env.LIVE === "1")("Capture and VAD on the real microphone", () => {
  it.live(
    "listens for 5 s and segments without an exception",
    () =>
      Effect.gen(function* () {
        const capture = makeCapture({
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() },
          audioDev: process.env.AUDIODEV,
        })
        const vad = yield* acquireSileroSession(model).pipe(Effect.flatMap(makeSileroVad))
        process.stdout.write(`capture device: ${yield* capture.device()}\n`)

        // 5 s of 32 ms frames.
        const utterances = yield* Stream.runCollect(
          segment(capture.frames().pipe(Stream.take(156)), vad, DEFAULT_SEGMENT_CONFIG),
        )

        expect(utterances.length).toBeGreaterThanOrEqual(0)
      }).pipe(Effect.scoped),
    30_000,
  )
})
