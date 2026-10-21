import { homedir } from "node:os"
import { join } from "node:path"
import { Config, ConfigProvider, Option } from "effect"
import { DEFAULT_SEGMENT_CONFIG, type SegmentConfig } from "../vad/segmenter.js"

export type AudioConfigShape = {
  // Value of AUDIODEV for sox; none means the system default input.
  readonly audioDev: Option.Option<string>
  readonly sileroModel: string
  readonly segment: SegmentConfig
  // Environment of `rec` and `play`: an allowlist, never the whole process env.
  readonly childEnv: Readonly<Record<string, string>>
}

// Same rule as the rest of the voice config: unset and blank both take the default.
const text = (name: string): Config.Config<string> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
  )

const invalid = (name: string, rule: string): Config.Config<never> =>
  Config.fail(new ConfigProvider.SourceError({ message: `${name} is invalid: ${rule}` }))

// Values from sox's AUDIODRIVER list; anything else would be handed to a native audio backend unchecked.
export const AUDIO_DRIVERS = ["coreaudio", "alsa", "pulseaudio", "oss", "waveaudio", "null"] as const

// A device name goes to sox through the environment: no control characters, no leading "-", bounded length.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const AUDIO_DEVICE = /^[^\u0000-\u001f\u007f-][^\u0000-\u001f\u007f]{0,255}$/

const audioDriver: Config.Config<string> = text("AUDIODRIVER").pipe(
  Config.flatMap((value) =>
    value === "" || (AUDIO_DRIVERS as ReadonlyArray<string>).includes(value)
      ? Config.succeed(value)
      : invalid("AUDIODRIVER", `expected one of ${AUDIO_DRIVERS.join(", ")}`),
  ),
)

const audioDevice: Config.Config<string> = text("AUDIODEV").pipe(
  Config.flatMap((value) =>
    value === "" || AUDIO_DEVICE.test(value)
      ? Config.succeed(value)
      : invalid("AUDIODEV", "up to 256 characters, no control characters, not starting with '-'"),
  ),
)

const positive = (name: string, fallback: number): Config.Config<number> =>
  text(name).pipe(
    Config.map((value) => {
      const parsed = Number(value)
      return value !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }),
  )

const threshold = (name: string, fallback: number): Config.Config<number> =>
  positive(name, fallback).pipe(Config.map((value) => (value <= 1 ? value : fallback)))

export const AudioConfig: Config.Config<AudioConfigShape> = Config.all({
  audioDev: audioDevice,
  audioDriver,
  sileroModel: text("SILERO_MODEL"),
  path: Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin")),
  threshold: threshold("VOICE_VAD_THRESHOLD", DEFAULT_SEGMENT_CONFIG.threshold),
  minSpeechMs: positive("VOICE_MIN_SPEECH_MS", DEFAULT_SEGMENT_CONFIG.minSpeechMs),
  minSilenceMs: positive("VOICE_MIN_SILENCE_MS", DEFAULT_SEGMENT_CONFIG.minSilenceMs),
  padMs: positive("VOICE_PAD_MS", DEFAULT_SEGMENT_CONFIG.padMs),
  maxUtteranceMs: positive("VOICE_MAX_UTTERANCE_MS", DEFAULT_SEGMENT_CONFIG.maxUtteranceMs),
}).pipe(
  Config.map(
    (values): AudioConfigShape => ({
      audioDev: values.audioDev === "" ? Option.none() : Option.some(values.audioDev),
      sileroModel:
        values.sileroModel === ""
          ? join(homedir(), ".app", "voice", "silero", "silero_vad.onnx")
          : values.sileroModel,
      segment: {
        threshold: values.threshold,
        minSpeechMs: values.minSpeechMs,
        minSilenceMs: values.minSilenceMs,
        padMs: values.padMs,
        maxUtteranceMs: values.maxUtteranceMs,
      },
      childEnv: {
        PATH: values.path,
        HOME: homedir(),
        ...(values.audioDriver === "" ? {} : { AUDIODRIVER: values.audioDriver }),
      },
    }),
  ),
)
