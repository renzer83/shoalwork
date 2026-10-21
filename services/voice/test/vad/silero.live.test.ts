import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { DEFAULT_SEGMENT_CONFIG, segment } from "../../src/vad/segmenter.js"
import { acquireSileroSession, makeSileroVad } from "../../src/vad/silero.js"
import { framesOf } from "./helpers.js"

const model =
  process.env.SILERO_MODEL?.trim() || join(homedir(), ".app", "voice", "silero", "silero_vad.onnx")

// Needs the official silero_vad.onnx (snakers4/silero-vad, src/silero_vad/data/). Runs only with LIVE=1.
describe.runIf(process.env.LIVE === "1" && existsSync(model))("SileroVad with the real model", () => {
  it.live("loads the model, confirms its I/O and finds the Portuguese phrase", () =>
    Effect.gen(function* () {
      const session = yield* acquireSileroSession(model)
      process.stdout.write(
        `silero inputs=${session.inputNames.join(",")} outputs=${session.outputNames.join(",")}\n`,
      )
      const vad = yield* makeSileroVad(session)
      const bytes = readFileSync(new URL("../fixtures/ola-mundo-16k.pcm", import.meta.url))
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))

      const utterances = yield* Stream.runCollect(
        segment(Stream.fromIterable(framesOf(pcm)), vad, DEFAULT_SEGMENT_CONFIG),
      )

      expect(utterances.length).toBeGreaterThanOrEqual(1)
      expect(utterances[0]?.maxProb).toBeGreaterThanOrEqual(0.8)
    }).pipe(Effect.scoped),
  )
})
