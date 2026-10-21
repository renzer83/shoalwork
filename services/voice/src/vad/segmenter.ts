import type { VoiceError } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { FRAME_MS, type Frame, type Utterance } from "../audio/frame.js"
import type { VadShape } from "./silero.js"

export type SegmentConfig = {
  // Probability at or above which a frame counts as speech.
  readonly threshold: number
  // Speech this long (consecutive frames) opens an utterance; shorter blips are dropped.
  readonly minSpeechMs: number
  // Silence this long closes it.
  readonly minSilenceMs: number
  // Audio kept before the first and after the last speech frame.
  readonly padMs: number
  // Hard cap on one utterance; a longer speech is cut and continues as the next one.
  readonly maxUtteranceMs: number
}

export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  threshold: 0.5,
  minSpeechMs: 250,
  minSilenceMs: 700,
  padMs: 200,
  maxUtteranceMs: 30_000,
}

type Scored = { readonly frame: Frame; readonly prob: number }

const toUtterance = (items: ReadonlyArray<Scored>): Utterance => {
  const total = items.reduce((sum, item) => sum + item.frame.pcm.length, 0)
  const pcm = new Int16Array(total)
  let offset = 0
  let maxProb = 0
  for (const item of items) {
    pcm.set(item.frame.pcm, offset)
    offset += item.frame.pcm.length
    maxProb = Math.max(maxProb, item.prob)
  }
  const first = items[0]
  const last = items[items.length - 1]
  return { pcm, startMs: first?.frame.t ?? 0, endMs: (last?.frame.t ?? 0) + FRAME_MS, maxProb }
}

// The state machine, one frame at a time. Counts are in whole 32 ms frames. Utterance times include the pads.
export class Segmenter {
  private mode: "silence" | "speech" = "silence"
  // Silence mode: the most recent frames, so an opening utterance can take its pre-roll.
  private ring: Scored[] = []
  private speechRun = 0
  // Speech mode: what has been collected, how many voiced frames it holds, and the trailing silent run.
  private utterance: Scored[] = []
  private voiced = 0
  private silenceRun = 0

  private readonly minSpeech: number
  private readonly minSilence: number
  private readonly pad: number
  private readonly max: number

  constructor(private readonly cfg: SegmentConfig) {
    this.minSpeech = Math.max(1, Math.ceil(cfg.minSpeechMs / FRAME_MS))
    this.minSilence = Math.max(1, Math.ceil(cfg.minSilenceMs / FRAME_MS))
    this.pad = Math.max(0, Math.ceil(cfg.padMs / FRAME_MS))
    // Room for the pads and at least one more frame, so a cut can never leave an utterance with no speech.
    this.max = Math.max(this.pad + this.minSpeech + 1, Math.floor(cfg.maxUtteranceMs / FRAME_MS))
  }

  push(frame: Frame, prob: number): ReadonlyArray<Utterance> {
    const item: Scored = { frame, prob }
    const speech = prob >= this.cfg.threshold
    return this.mode === "silence" ? this.pushSilence(item, speech) : this.pushSpeech(item, speech)
  }

  // End of the stream: an utterance still open is closed, if it holds at least minSpeechMs of speech.
  flush(): ReadonlyArray<Utterance> {
    if (this.mode !== "speech" || this.voiced < this.minSpeech) return []
    this.trimTrailingSilence()
    const done = toUtterance(this.utterance)
    this.reset()
    return [done]
  }

  private pushSilence(item: Scored, speech: boolean): ReadonlyArray<Utterance> {
    this.ring.push(item)
    if (this.ring.length > this.pad + this.minSpeech) this.ring.shift()
    this.speechRun = speech ? this.speechRun + 1 : 0
    if (this.speechRun < this.minSpeech) return []
    this.mode = "speech"
    this.utterance = this.ring
    this.voiced = this.speechRun
    this.silenceRun = 0
    this.ring = []
    this.speechRun = 0
    return []
  }

  private pushSpeech(item: Scored, speech: boolean): ReadonlyArray<Utterance> {
    this.utterance.push(item)
    if (speech) {
      this.voiced += 1
      this.silenceRun = 0
    } else {
      this.silenceRun += 1
    }
    if (this.silenceRun >= this.minSilence) {
      // A tail left after a max-length cut with less than minSpeechMs of speech is not an utterance.
      if (this.voiced < this.minSpeech) {
        this.reset()
        return []
      }
      const dropped = this.trimTrailingSilence()
      const done = toUtterance(this.utterance)
      this.reset()
      // The silence that was cut off is the pre-roll of whatever comes next.
      this.ring = dropped.slice(-(this.pad + this.minSpeech))
      return [done]
    }
    if (this.utterance.length >= this.max) {
      const done = toUtterance(this.utterance)
      // The silent run is kept: silence that straddles the cut still counts toward closing the next utterance.
      this.utterance = []
      this.voiced = 0
      return [done]
    }
    return []
  }

  // Keeps `pad` frames of the silence that ends the utterance; returns the frames it removed.
  private trimTrailingSilence(): Scored[] {
    const drop = Math.max(0, Math.min(this.silenceRun - this.pad, this.utterance.length))
    return drop === 0 ? [] : this.utterance.splice(this.utterance.length - drop, drop)
  }

  private reset(): void {
    this.mode = "silence"
    this.ring = []
    this.speechRun = 0
    this.utterance = []
    this.voiced = 0
    this.silenceRun = 0
  }
}

// A new run of the stream is a new recording: the VAD state is zeroed first, and a fresh Segmenter is used.
export const segment = (
  frames: Stream.Stream<Frame, VoiceError>,
  vad: VadShape,
  cfg: SegmentConfig,
): Stream.Stream<Utterance, VoiceError> =>
  Stream.unwrap(
    vad.reset().pipe(
      Effect.as(
        frames.pipe(
          Stream.mapAccumEffect(
            () => new Segmenter(cfg),
            (segmenter, frame) =>
              vad
                .prob(frame.pcm)
                .pipe(Effect.map((prob) => [segmenter, segmenter.push(frame, prob)] as const)),
            { onHalt: (segmenter) => segmenter.flush() },
          ),
        ),
      ),
    ),
  )
