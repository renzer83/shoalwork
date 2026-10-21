import { availableParallelism } from "node:os"
import { dirname, join } from "node:path"
import {
  type SidecarName,
  type SynthesizeRequest,
  type TranscribeRequest,
  type TranscribeResponse,
  VoiceError,
  type VoiceHealth,
} from "@shoalwork/contracts"
import { Context, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import type { VoiceConfigShape } from "./config.js"
import { sayPcm } from "./say.js"
import {
  DEFAULT_SUPERVISOR,
  defaultSpawnProcess,
  probe,
  type SidecarSpec,
  type SidecarStatus,
  type SpawnProcess,
  type SupervisorOptions,
  superviseSidecar,
} from "./supervisor.js"
import { buildWav } from "./wav.js"

// Fixed loopback ports of the sidecars (02-architecture §19).
export const STT_PORT = 28921
export const TTS_PORT = 28922
export const STT_URL = `http://127.0.0.1:${STT_PORT}`
export const TTS_URL = `http://127.0.0.1:${TTS_PORT}`
export const STT_TIMEOUT_MS = 30_000

// The file the Kokoro sidecar needs next to the model directory (research voice-local.md §4).
export const KOKORO_MODEL_FILE = "kokoro-v1.0.onnx"
export const KOKORO_VOICES_FILE = "voices-v1.0.bin"

export type VoiceSidecarsShape = {
  readonly start: () => Effect.Effect<void, VoiceError, Scope.Scope>
  readonly health: () => Effect.Effect<VoiceHealth>
  readonly transcribe: (req: TranscribeRequest) => Effect.Effect<TranscribeResponse, VoiceError>
  readonly synthesize: (req: SynthesizeRequest) => Stream.Stream<Uint8Array, VoiceError>
}

export class VoiceSidecars extends Context.Service<VoiceSidecars, VoiceSidecarsShape>()(
  "@shoalwork/VoiceSidecars",
) {}

// Test seams: a fake spawn, a shorter STT timeout, a fake platform, faster supervision.
export type VoiceOptions = {
  readonly sttTimeoutMs?: number
  readonly platform?: NodeJS.Platform
  readonly spawnProcess?: SpawnProcess
  readonly supervisor?: Partial<SupervisorOptions>
}

// whisper-server verbose_json (examples/server in whisper.cpp v1.9.5): language names are full names ("portuguese").
const WhisperVerbose = Schema.Struct({
  text: Schema.String,
  language: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Number),
  detected_language: Schema.optionalKey(Schema.String),
  detected_language_probability: Schema.optionalKey(Schema.Number),
  segments: Schema.optionalKey(
    Schema.Array(Schema.Struct({ text: Schema.String, start: Schema.Number, end: Schema.Number })),
  ),
})
const decodeWhisper = Schema.decodeUnknownEffect(WhisperVerbose)

const toTranscribeResponse = (raw: typeof WhisperVerbose.Type): TranscribeResponse => ({
  text: raw.text,
  language: raw.detected_language ?? raw.language ?? "",
  languageProbability: raw.detected_language_probability ?? 0,
  durationMs: Math.round((raw.duration ?? 0) * 1000),
  segments: (raw.segments ?? []).map((segment) => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
  })),
})

const sttSpec = (config: VoiceConfigShape): SidecarSpec => ({
  name: "stt",
  command: config.whisperBin,
  args: [
    "-m",
    config.whisperModel,
    "-l",
    "auto",
    "--host",
    "127.0.0.1",
    "--port",
    String(STT_PORT),
    "-t",
    String(Math.max(1, Math.floor(availableParallelism() / 2))),
  ],
  cwd: dirname(config.whisperModel),
  env: config.childEnv,
  healthUrl: `${STT_URL}/health`,
  requiredFiles: [config.whisperBin, config.whisperModel],
})

const ttsSpec = (config: VoiceConfigShape): SidecarSpec => ({
  name: "tts",
  command: config.ttsCommand,
  args: ["tts_server:app", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
  cwd: config.ttsCwd,
  env: { ...config.childEnv, KOKORO_DIR: config.kokoroDir },
  healthUrl: `${TTS_URL}/health`,
  requiredFiles: [
    config.ttsCommand,
    join(config.kokoroDir, KOKORO_MODEL_FILE),
    join(config.kokoroDir, KOKORO_VOICES_FILE),
  ],
})

const ttsHttp = (base: string, req: SynthesizeRequest): Stream.Stream<Uint8Array, VoiceError> =>
  Stream.unwrap(
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${base}/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: req.text,
            language: req.language,
            voice: req.voice,
            speed: req.speed,
          }),
          signal,
        }),
      catch: () => new VoiceError({ op: "tts", reason: "request failed" }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok && response.body !== null
          ? Effect.succeed(response.body)
          : Effect.fail(new VoiceError({ op: "tts", reason: `status ${response.status}` })),
      ),
      Effect.map((body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: () => new VoiceError({ op: "tts", reason: "stream interrupted" }),
        }),
      ),
    ),
  )

// Pure assembly of the service. The Layer below is the only place that reads the config.
export const makeVoiceSidecars = (
  config: VoiceConfigShape,
  options: VoiceOptions = {},
): VoiceSidecarsShape => {
  const platform = options.platform ?? process.platform
  const sttTimeoutMs = options.sttTimeoutMs ?? STT_TIMEOUT_MS
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess
  const supervisor: SupervisorOptions = { ...DEFAULT_SUPERVISOR, spawnProcess, ...options.supervisor }
  const states: Record<SidecarName, SidecarStatus> = {
    stt: { state: "starting", restarts: 0 },
    tts: { state: "starting", restarts: 0 },
  }
  const sttBase = Option.getOrElse(config.sttUrl, () => STT_URL)
  const ttsBase = Option.getOrElse(config.ttsUrl, () => TTS_URL)

  const report = (name: SidecarName) => (status: SidecarStatus) =>
    Effect.sync(() => {
      states[name] = status
    }).pipe(
      Effect.andThen(
        status.state === "restarting"
          ? Effect.logWarning(
              `voice.sidecar_restarted sidecar=${name} restarts=${status.restarts} ${status.reason ?? ""}`,
            )
          : status.state === "unavailable"
            ? Effect.logWarning(`voice.error sidecar=${name} ${status.reason ?? ""}`)
            : Effect.void,
      ),
    )

  // Server mode: the URL is someone else's process. It is only probed, never spawned.
  const watchExternal = (name: SidecarName, url: string) =>
    Effect.gen(function* () {
      const check = Effect.gen(function* () {
        const ok = yield* probe(`${url}/health`, supervisor.probeTimeoutMs)
        states[name] = ok
          ? { state: "ready", restarts: 0 }
          : { state: "unavailable", restarts: 0, reason: "health probe failed" }
      })
      yield* check
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(supervisor.healthIntervalMs).pipe(Effect.andThen(check))),
      )
    })

  const start = () =>
    Effect.gen(function* () {
      for (const url of [config.sttUrl, config.ttsUrl].flatMap((option) => Option.toArray(option))) {
        yield* Effect.try({
          try: () => new URL(url),
          catch: () => new VoiceError({ op: "start", reason: "sidecar URL is not a valid URL" }),
        })
      }
      yield* Option.match(config.sttUrl, {
        onNone: () => Effect.forkScoped(superviseSidecar(sttSpec(config), supervisor, report("stt"))),
        onSome: (url) => watchExternal("stt", url),
      })
      yield* Option.match(config.ttsUrl, {
        onNone: () => Effect.forkScoped(superviseSidecar(ttsSpec(config), supervisor, report("tts"))),
        onSome: (url) => watchExternal("tts", url),
      })
      // Boot waits until each sidecar is ready or has given up, so the first health answer is real.
      const deadline = Date.now() + supervisor.startupTimeoutMs
      while (
        Date.now() < deadline &&
        (states.stt.state === "starting" ||
          states.stt.state === "restarting" ||
          states.tts.state === "starting" ||
          states.tts.state === "restarting")
      ) {
        yield* Effect.sleep(100)
      }
    })

  const transcribe = (req: TranscribeRequest) =>
    Effect.gen(function* () {
      if (req.pcm16k.length % 2 !== 0) {
        return yield* Effect.fail(new VoiceError({ op: "stt", reason: "pcm16k length must be even (s16le)" }))
      }
      if (states.stt.state !== "ready") {
        return yield* Effect.fail(new VoiceError({ op: "stt", reason: "stt sidecar unavailable" }))
      }
      const form = new FormData()
      form.append("file", new Blob([buildWav(req.pcm16k)], { type: "audio/wav" }), "audio.wav")
      form.append("language", req.language ?? "auto")
      form.append("response_format", "verbose_json")
      if (req.prompt !== undefined) form.append("prompt", req.prompt)
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(`${sttBase}/inference`, { method: "POST", body: form, signal }),
        catch: () => new VoiceError({ op: "stt", reason: "request failed" }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: sttTimeoutMs,
          orElse: () =>
            Effect.fail(new VoiceError({ op: "stt", reason: `timeout after ${sttTimeoutMs} ms` })),
        }),
      )
      if (!response.ok) {
        return yield* Effect.fail(new VoiceError({ op: "stt", reason: `status ${response.status}` }))
      }
      const json = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => response.json(),
        catch: () => new VoiceError({ op: "stt", reason: "response is not JSON" }),
      })
      const raw = yield* decodeWhisper(json).pipe(
        Effect.mapError(() => new VoiceError({ op: "stt", reason: "unexpected response shape" })),
      )
      return toTranscribeResponse(raw)
    })

  const synthesize = (req: SynthesizeRequest): Stream.Stream<Uint8Array, VoiceError> =>
    Stream.unwrap(
      Effect.sync((): Stream.Stream<Uint8Array, VoiceError> => {
        if (states.tts.state === "ready") return ttsHttp(ttsBase, req)
        // The macOS fallback speaks Portuguese only; other languages have no local voice without the sidecar.
        if (platform === "darwin" && req.language === "pt") {
          return Stream.fromEffect(sayPcm(req.text, spawnProcess))
        }
        return Stream.fail(new VoiceError({ op: "tts", reason: "tts sidecar unavailable" }))
      }),
    )

  return {
    start,
    health: () =>
      Effect.sync(() => ({ stt: states.stt.state === "ready", tts: states.tts.state === "ready" })),
    transcribe,
    synthesize,
  }
}

export const VoiceSidecarsLive = (
  config: VoiceConfigShape,
  options?: VoiceOptions,
): Layer.Layer<VoiceSidecars> => Layer.succeed(VoiceSidecars, makeVoiceSidecars(config, options))
