import { homedir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import { AudioConfig } from "../../src/audio/config.js"
import { DEFAULT_SEGMENT_CONFIG } from "../../src/vad/segmenter.js"

const parse = (env: Record<string, string>) =>
  Effect.runSync(AudioConfig.parse(ConfigProvider.fromEnvRecord(env)))

const fail = (env: Record<string, string>) =>
  Effect.runSync(Effect.flip(AudioConfig.parse(ConfigProvider.fromEnvRecord(env))))

describe("AudioConfig", () => {
  it("takes the defaults when nothing is set or the values are blank", () => {
    for (const env of [
      { PATH: "/bin" },
      { PATH: "/bin", SILERO_MODEL: "  ", VOICE_VAD_THRESHOLD: "", AUDIODEV: "" },
    ]) {
      const config = parse(env)
      expect(config.segment).toEqual(DEFAULT_SEGMENT_CONFIG)
      expect(config.sileroModel).toBe(join(homedir(), ".app", "voice", "silero", "silero_vad.onnx"))
      expect(Option.isNone(config.audioDev)).toBe(true)
      expect(config.childEnv).toEqual({ PATH: "/bin", HOME: homedir() })
    }
  })

  it("reads overrides, ignores nonsense and only exports an allowlist to the child", () => {
    const config = parse({
      PATH: "/opt/homebrew/bin:/usr/bin",
      AUDIODEV: "USB Mic",
      AUDIODRIVER: "coreaudio",
      SILERO_MODEL: "/models/silero.onnx",
      VOICE_VAD_THRESHOLD: "0.6",
      VOICE_MIN_SPEECH_MS: "300",
      VOICE_MIN_SILENCE_MS: "-5",
      VOICE_PAD_MS: "abc",
      VOICE_MAX_UTTERANCE_MS: "20000",
      TELEGRAM_BOT_TOKEN: "must-not-leak",
    })

    expect(config.segment).toEqual({
      ...DEFAULT_SEGMENT_CONFIG,
      threshold: 0.6,
      minSpeechMs: 300,
      maxUtteranceMs: 20_000,
    })
    expect(config.sileroModel).toBe("/models/silero.onnx")
    expect(config.audioDev).toEqual(Option.some("USB Mic"))
    expect(config.childEnv).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: homedir(),
      AUDIODRIVER: "coreaudio",
    })
  })

  it("rejects a threshold above 1", () => {
    expect(parse({ PATH: "/bin", VOICE_VAD_THRESHOLD: "1.5" }).segment.threshold).toBe(0.5)
  })

  it("accepts the known AUDIODRIVER values and ordinary device names", () => {
    for (const driver of ["coreaudio", "alsa", "pulseaudio", "oss", "waveaudio", "null"])
      expect(Option.isSome(parse({ PATH: "/bin", AUDIODRIVER: driver }).audioDev)).toBe(false)
    for (const device of ["Built-in Microphone", "hw:1,0", "default", "a".repeat(256)])
      expect(parse({ PATH: "/bin", AUDIODEV: device }).audioDev).toEqual(Option.some(device))
  })

  it("rejects an AUDIODRIVER outside the known set, naming the variable but not echoing the value", () => {
    const error = fail({ PATH: "/bin", AUDIODRIVER: "../../evil" })

    expect(error.message).toContain("AUDIODRIVER")
    expect(error.message).toContain("coreaudio")
    expect(error.message).not.toContain("evil")
  })

  it("rejects an AUDIODEV with a leading dash, control characters or too many characters", () => {
    for (const device of ["-n", "mic\u0000x", "mic\nx", "mic\u007fx", "a".repeat(257)]) {
      const error = fail({ PATH: "/bin", AUDIODEV: device })
      expect(error.message).toContain("AUDIODEV")
    }
  })
})
