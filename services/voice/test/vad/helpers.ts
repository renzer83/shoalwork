import { readFileSync } from "node:fs"
import { VoiceError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { FRAME_MS, FRAME_SAMPLES, type Frame } from "../../src/audio/frame.js"
import type { VadShape } from "../../src/vad/silero.js"

export const fixturePcm = (name: string): Int16Array => {
  const bytes = readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url))
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

export const framesOf = (pcm: Int16Array): ReadonlyArray<Frame> => {
  const frames: Frame[] = []
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES)
    frames.push({ pcm: pcm.slice(i, i + FRAME_SAMPLES), t: (i / FRAME_SAMPLES) * FRAME_MS })
  return frames
}

const rms = (pcm: Int16Array): number => {
  let sum = 0
  for (const sample of pcm) sum += sample * sample
  return Math.sqrt(sum / pcm.length)
}

// Stands in for the Silero model: loudness as a probability. The fixtures are far apart (rms ~17 vs ~4000).
export const energyVad = (): VadShape & { readonly resets: () => number } => {
  let resets = 0
  return {
    prob: (frame) => Effect.succeed(Math.min(1, rms(frame) / 1500)),
    reset: () =>
      Effect.sync(() => {
        resets += 1
      }),
    resets: () => resets,
  }
}

// Probability per frame index, read from the first sample of each frame (tests mark frames that way).
export const scriptedVad = (probs: ReadonlyArray<number>): VadShape => ({
  prob: (frame) => Effect.succeed(probs[frame[0] ?? 0] ?? 0),
  reset: () => Effect.void,
})

export const markedFrames = (count: number): ReadonlyArray<Frame> =>
  Array.from({ length: count }, (_, index) => {
    const pcm = new Int16Array(FRAME_SAMPLES)
    pcm[0] = index
    return { pcm, t: index * FRAME_MS }
  })

export const failingVad: VadShape = {
  prob: () => Effect.fail(new VoiceError({ op: "vad", reason: "boom" })),
  reset: () => Effect.void,
}
