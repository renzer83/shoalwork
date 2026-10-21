import { describe, expect, it } from "vitest"
import { FRAME_MS, FRAME_SAMPLES, type Utterance } from "../../src/audio/frame.js"
import { type SegmentConfig, Segmenter } from "../../src/vad/segmenter.js"

// Frames of 32 ms: speech needs 2 frames, a pause of 4 closes, the pad is 3 frames, a cut comes at 20 frames.
const cfg: SegmentConfig = {
  threshold: 0.5,
  minSpeechMs: 64,
  minSilenceMs: 128,
  padMs: 96,
  maxUtteranceMs: 640,
}

// 's' = speech frame, 'x' = silence frame. Frame i is filled with the value i + 1, so the pcm says where it came from.
const drive = (script: string, config: SegmentConfig = cfg): Utterance[] => {
  const segmenter = new Segmenter(config)
  const out: Utterance[] = []
  for (const [index, mark] of [...script].entries()) {
    const pcm = new Int16Array(FRAME_SAMPLES).fill(index + 1)
    out.push(...segmenter.push({ pcm, t: index * FRAME_MS }, mark === "s" ? 0.9 : 0.01))
  }
  out.push(...segmenter.flush())
  return out
}

// The frame numbers an utterance is made of, read back from its samples.
const framesIn = (u: Utterance): number[] => {
  const ids: number[] = []
  for (let at = 0; at < u.pcm.length; at += FRAME_SAMPLES) ids.push((u.pcm[at] ?? 0) - 1)
  return ids
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe("Segmenter edges", () => {
  it("takes a pre-roll shorter than the pad when speech starts near the beginning", () => {
    const [only, ...rest] = drive(`xss${"s".repeat(3)}${"x".repeat(8)}`)

    expect(rest).toHaveLength(0)
    expect(only?.startMs).toBe(0)
    // 1 silent frame before (pad would allow 3), speech 1..5, pad 3 after: 6, 7, 8.
    expect(framesIn(only as Utterance)).toEqual(range(0, 8))
  })

  it("cuts at the maximum length and keeps the pieces contiguous with nothing lost or repeated", () => {
    const utterances = drive("s".repeat(45))

    expect(utterances.map((u) => [u.startMs, u.endMs])).toEqual([
      [0, 20 * FRAME_MS],
      [20 * FRAME_MS, 40 * FRAME_MS],
      [40 * FRAME_MS, 45 * FRAME_MS],
    ])
    expect(utterances.flatMap(framesIn)).toEqual(range(0, 44))
  })

  it("discards the tail after a cut when it holds no speech", () => {
    // The 20th speech frame triggers the cut; the silence after it is not an utterance.
    const utterances = drive(`${"s".repeat(20)}${"x".repeat(10)}`)

    expect(utterances).toHaveLength(1)
    expect(framesIn(utterances[0] as Utterance)).toEqual(range(0, 19))
  })

  it("discards the tail after a cut when its speech is shorter than minSpeechMs", () => {
    const utterances = drive(`${"s".repeat(21)}${"x".repeat(10)}`)

    expect(utterances).toHaveLength(1)
    expect(utterances[0]?.endMs).toBe(20 * FRAME_MS)
  })

  it("keeps a tail after a cut when it has enough speech", () => {
    const utterances = drive(`${"s".repeat(22)}${"x".repeat(10)}`)

    expect(utterances).toHaveLength(2)
    // 2 speech frames plus the 3-frame pad of silence.
    expect(framesIn(utterances[1] as Utterance)).toEqual(range(20, 24))
  })

  it("counts silence that straddles a cut toward closing, so later speech opens a fresh utterance", () => {
    // Speech 0..16, silence 17..20 (the cut is at frame 19), speech 22..27, silence.
    const utterances = drive(`${"s".repeat(17)}${"x".repeat(5)}${"s".repeat(6)}${"x".repeat(8)}`)

    expect(utterances).toHaveLength(2)
    expect(utterances[0]?.endMs).toBe(20 * FRAME_MS)
    // Silence mode again after frame 20: the pre-roll is frame 21 only, not the silent tail before it.
    expect(utterances[1]?.startMs).toBe(21 * FRAME_MS)
  })

  it("closes an utterance still open when the stream ends in silence, with the trailing silence it has", () => {
    const utterances = drive(`xx${"s".repeat(6)}xx`)

    expect(utterances).toHaveLength(1)
    // Pre-roll 0..1 (only 2 frames exist), speech 2..7, silence 8..9 (fewer than the 4 that close it).
    expect(framesIn(utterances[0] as Utterance)).toEqual(range(0, 9))
    expect(utterances[0]?.endMs).toBe(10 * FRAME_MS)
  })

  it("drops speech that is still shorter than minSpeechMs when the stream ends", () => {
    expect(drive("xxxs")).toHaveLength(0)
  })

  it("hands the silence it cut off to the next utterance as pre-roll", () => {
    // Speech 0..3; silence 4..7 closes it (pad keeps 4..6, frame 7 is cut off); speech 8..11 follows at once.
    const utterances = drive(`${"s".repeat(4)}${"x".repeat(4)}${"s".repeat(4)}${"x".repeat(8)}`)

    expect(utterances).toHaveLength(2)
    expect(framesIn(utterances[0] as Utterance)).toEqual(range(0, 6))
    expect(utterances[0]?.endMs).toBe(7 * FRAME_MS)
    // Pre-roll = frame 7 (cut off from the first) and nothing older, so the second starts where the first ended.
    expect(utterances[1]?.startMs).toBe(7 * FRAME_MS)
    expect(framesIn(utterances[1] as Utterance).slice(0, 3)).toEqual([7, 8, 9])
  })

  it("never lets a tiny maxUtteranceMs produce utterances without speech: the cut is clamped above pad + minSpeech", () => {
    const utterances = drive("s".repeat(13), { ...cfg, maxUtteranceMs: 100 })

    // Clamped to 6 frames (3 pad + 2 speech + 1): two full pieces, the 1-frame remainder is dropped.
    expect(utterances.map((u) => u.pcm.length / FRAME_SAMPLES)).toEqual([6, 6])
  })

  it("reports the highest probability among the frames it contains", () => {
    const segmenter = new Segmenter(cfg)
    const probs = [0.01, 0.9, 0.7, 0.95, 0.9, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.99]
    const out: Utterance[] = []
    for (const [index, prob] of probs.entries())
      out.push(...segmenter.push({ pcm: new Int16Array(FRAME_SAMPLES), t: index * FRAME_MS }, prob))

    // The 0.99 frame comes after the utterance closed: it must not leak into it.
    expect(out).toHaveLength(1)
    expect(out[0]?.maxProb).toBe(0.95)
  })
})
