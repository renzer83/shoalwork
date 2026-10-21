import { Data, Schema } from "effect"

// Contracts of the two local voice sidecars (ADR-017): STT = whisper.cpp whisper-server, TTS = Kokoro (services/voice/python).

export const SidecarName = Schema.Literals(["stt", "tts"])
export type SidecarName = typeof SidecarName.Type

// s16le mono 16 kHz PCM; the sidecar receives it wrapped in a WAV header.
export const TranscribeRequest = Schema.Struct({
  pcm16k: Schema.Uint8Array,
  language: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
})
export type TranscribeRequest = typeof TranscribeRequest.Type

export const TranscribeSegment = Schema.Struct({
  text: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
})
export type TranscribeSegment = typeof TranscribeSegment.Type

export const TranscribeResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.String,
  languageProbability: Schema.Number,
  durationMs: Schema.Int,
  segments: Schema.Array(TranscribeSegment),
})
export type TranscribeResponse = typeof TranscribeResponse.Type

export const SynthesizeLanguage = Schema.Literals(["pt", "en", "es"])
export type SynthesizeLanguage = typeof SynthesizeLanguage.Type

// The response is a chunked stream of PCM s16le mono 24 kHz, not a schema value.
export const SynthesizeRequest = Schema.Struct({
  text: Schema.String,
  language: SynthesizeLanguage,
  voice: Schema.optionalKey(Schema.String),
  speed: Schema.optionalKey(Schema.Number),
})
export type SynthesizeRequest = typeof SynthesizeRequest.Type

export const SidecarState = Schema.Literals(["starting", "ready", "restarting", "unavailable"])
export type SidecarState = typeof SidecarState.Type

export const SidecarHealth = Schema.Struct({
  name: SidecarName,
  state: SidecarState,
  restarts: Schema.Int,
  reason: Schema.optionalKey(Schema.String),
})
export type SidecarHealth = typeof SidecarHealth.Type

export const VoiceHealth = Schema.Struct({
  stt: Schema.Boolean,
  tts: Schema.Boolean,
})
export type VoiceHealth = typeof VoiceHealth.Type

// Supervisor notifications. Not in the Beacon event list yet: that list is closed (02-architecture §3).
export const SidecarEvent = Schema.Struct({
  type: Schema.Literals(["voice.sidecar_restarted", "voice.error"]),
  sidecar: SidecarName,
  attempt: Schema.Int,
  reason: Schema.String,
})
export type SidecarEvent = typeof SidecarEvent.Type

export class VoiceError extends Data.TaggedError("VoiceError")<{
  readonly op: SidecarName | "start" | "capture" | "playback" | "vad"
  readonly reason: string
}> {}
