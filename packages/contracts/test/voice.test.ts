import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  SidecarEvent,
  SidecarHealth,
  SynthesizeRequest,
  TranscribeRequest,
  TranscribeResponse,
  VoiceError,
  VoiceHealth,
} from "../src/voice.js"

describe("voice contracts", () => {
  it("round-trips a transcribe request with its PCM bytes", () => {
    const decoded = Schema.decodeUnknownSync(TranscribeRequest)({
      pcm16k: new Uint8Array([1, 2, 3, 4]),
      language: "pt",
    })
    const encoded = Schema.encodeSync(TranscribeRequest)(decoded)
    expect(encoded.pcm16k).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(encoded.language).toBe("pt")
    expect(() => Schema.decodeUnknownSync(TranscribeRequest)({ pcm16k: "not bytes" })).toThrow()
  })

  it("round-trips a transcribe response and rejects a fractional durationMs", () => {
    const value = {
      text: "olá",
      language: "portuguese",
      languageProbability: 0.9,
      durationMs: 1200,
      segments: [{ text: "olá", start: 0, end: 1.2 }],
    }
    expect(
      Schema.encodeSync(TranscribeResponse)(Schema.decodeUnknownSync(TranscribeResponse)(value)),
    ).toEqual(value)
    expect(() => Schema.decodeUnknownSync(TranscribeResponse)({ ...value, durationMs: 1.5 })).toThrow()
  })

  it("round-trips a synthesize request and rejects a language outside pt, en and es", () => {
    const value = { text: "teste", language: "pt", speed: 1.1 }
    expect(Schema.encodeSync(SynthesizeRequest)(Schema.decodeUnknownSync(SynthesizeRequest)(value))).toEqual(
      value,
    )
    expect(() => Schema.decodeUnknownSync(SynthesizeRequest)({ text: "teste", language: "fr" })).toThrow()
  })

  it("round-trips sidecar health and rejects an unknown state", () => {
    const value = { name: "tts", state: "unavailable", restarts: 3, reason: "gave up" }
    expect(Schema.encodeSync(SidecarHealth)(Schema.decodeUnknownSync(SidecarHealth)(value))).toEqual(value)
    expect(() => Schema.decodeUnknownSync(SidecarHealth)({ ...value, state: "sleeping" })).toThrow()
    expect(Schema.decodeUnknownSync(VoiceHealth)({ stt: true, tts: false })).toEqual({
      stt: true,
      tts: false,
    })
  })

  it("round-trips a sidecar event and rejects a type outside the voice namespace", () => {
    const value = { type: "voice.sidecar_restarted", sidecar: "stt", attempt: 1, reason: "exited with 1" }
    expect(Schema.encodeSync(SidecarEvent)(Schema.decodeUnknownSync(SidecarEvent)(value))).toEqual(value)
    expect(() => Schema.decodeUnknownSync(SidecarEvent)({ ...value, type: "task.received" })).toThrow()
  })

  it("carries the operation and the reason as typed fields", () => {
    const error = new VoiceError({ op: "tts", reason: "tts sidecar unavailable" })
    expect(error._tag).toBe("VoiceError")
    expect(error.op).toBe("tts")
    expect(error.reason).toBe("tts sidecar unavailable")
  })
})
