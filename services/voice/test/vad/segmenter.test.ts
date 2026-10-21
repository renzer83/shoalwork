import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { VoiceError } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { FRAME_MS, type Frame } from "../../src/audio/frame.js"
import { DEFAULT_SEGMENT_CONFIG, segment } from "../../src/vad/segmenter.js"
import type { VadShape } from "../../src/vad/silero.js"
import { energyVad, failingVad, fixturePcm, framesOf, markedFrames, scriptedVad } from "./helpers.js"

const run = (frames: ReadonlyArray<Frame>, vad: VadShape = energyVad(), cfg = DEFAULT_SEGMENT_CONFIG) =>
  Stream.runCollect(segment(Stream.fromIterable(frames), vad, cfg))

describe("segment", () => {
  it.effect("turns one spoken phrase into one utterance padded by 200 ms", () =>
    Effect.gen(function* () {
      const fixture = fixturePcm("speech-16k.pcm")
      const utterances = yield* run(framesOf(fixture))

      expect(utterances).toHaveLength(1)
      const [only] = utterances
      // The pcm is the recording itself, pads included, not just something of the right size.
      expect(only?.pcm).toEqual(fixture.slice(9 * 512, 70 * 512))
      expect(only?.maxProb).toBeGreaterThanOrEqual(0.8)
      // Speech is frames 16..62: 7 frames of pre-roll and 7 of trailing silence are kept.
      expect(only?.startMs).toBe(9 * FRAME_MS)
      expect(only?.endMs).toBe(70 * FRAME_MS)
      expect(only?.pcm.length).toBe(61 * 512)
    }),
  )

  it.effect("finds the speech in the recorded Portuguese phrase", () =>
    Effect.gen(function* () {
      const bytes = readFileSync(new URL("../fixtures/ola-mundo-16k.pcm", import.meta.url))
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))

      const utterances = yield* run(framesOf(pcm))

      expect(utterances.length).toBeGreaterThanOrEqual(1)
      expect(utterances[0]?.maxProb).toBeGreaterThanOrEqual(0.8)
    }),
  )

  it.effect("emits nothing for silence", () =>
    Effect.gen(function* () {
      expect(yield* run(framesOf(fixturePcm("silence-16k.pcm")))).toHaveLength(0)
    }),
  )

  it.effect("splits two phrases at the pause and flushes the one open at the end", () =>
    Effect.gen(function* () {
      const fixture = fixturePcm("two-utterances-16k.pcm")
      const utterances = yield* run(framesOf(fixture))

      expect(utterances.map((u) => [u.startMs, u.endMs])).toEqual([
        [5 * FRAME_MS, 50 * FRAME_MS],
        [83 * FRAME_MS, 128 * FRAME_MS],
      ])
      expect(utterances.every((u) => u.maxProb >= 0.8)).toBe(true)
      expect(utterances[0]?.pcm).toEqual(fixture.slice(5 * 512, 50 * 512))
      expect(utterances[1]?.pcm).toEqual(fixture.slice(83 * 512, 128 * 512))
    }),
  )

  it.effect("cuts a 40 s speech at maxUtteranceMs and continues with the rest", () =>
    Effect.gen(function* () {
      const base = framesOf(fixturePcm("speech-16k.pcm"))
      const lead = base.slice(0, 16)
      const voice = base.slice(16, 63)
      const tail = base.slice(63)
      const repeated = Array.from({ length: 27 }, () => voice).flat()
      const frames = [...lead, ...repeated, ...tail].map((frame, index) => ({
        ...frame,
        t: index * FRAME_MS,
      }))
      expect(frames.length * FRAME_MS).toBeGreaterThan(40_000)

      const utterances = yield* run(frames)

      expect(utterances).toHaveLength(2)
      expect(utterances.every((u) => u.endMs - u.startMs <= DEFAULT_SEGMENT_CONFIG.maxUtteranceMs)).toBe(true)
      expect(utterances[1]?.startMs).toBe(utterances[0]?.endMs)
    }),
  )

  it.effect("drops a burst shorter than minSpeechMs", () =>
    Effect.gen(function* () {
      // 6 loud frames (192 ms < 250 ms) among silence.
      const probs = Array.from({ length: 60 }, (_, i) => (i >= 10 && i < 16 ? 0.9 : 0.01))
      const utterances = yield* run(markedFrames(60), scriptedVad(probs))
      expect(utterances).toHaveLength(0)
    }),
  )

  it.effect("keeps one utterance across a pause shorter than minSilenceMs", () =>
    Effect.gen(function* () {
      // speech 10..29, a 10-frame (320 ms) pause, speech 40..59, then silence until the end.
      const probs = Array.from({ length: 120 }, (_, i) =>
        (i >= 10 && i < 30) || (i >= 40 && i < 60) ? 0.9 : 0.01,
      )
      const utterances = yield* run(markedFrames(120), scriptedVad(probs))
      expect(utterances).toHaveLength(1)
      expect(utterances[0]?.startMs).toBe(3 * FRAME_MS)
    }),
  )

  it.effect("applies the threshold: a probability just below it is not speech", () =>
    Effect.gen(function* () {
      const probs = Array.from({ length: 60 }, (_, i) => (i >= 5 && i < 40 ? 0.49 : 0))
      expect(yield* run(markedFrames(60), scriptedVad(probs))).toHaveLength(0)
      const above = probs.map((p) => (p === 0.49 ? 0.5 : p))
      expect(yield* run(markedFrames(60), scriptedVad(above))).toHaveLength(1)
    }),
  )

  it.effect("resets the VAD state when a run starts", () =>
    Effect.gen(function* () {
      const vad = energyVad()
      yield* run(framesOf(fixturePcm("silence-16k.pcm")), vad)
      yield* run(framesOf(fixturePcm("silence-16k.pcm")), vad)
      expect(vad.resets()).toBe(2)
    }),
  )

  it.effect("fails with the VAD error and emits nothing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(framesOf(fixturePcm("speech-16k.pcm")), failingVad))
      expect(error).toBeInstanceOf(VoiceError)
      expect(error.reason).toBe("boom")
    }),
  )
})
