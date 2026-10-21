import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SynthesizeLanguage } from "@shoalwork/contracts"
import { Config, Option, Schema } from "effect"

export type VoiceConfigShape = {
  // Server mode (no spawn): when set, the sidecar at this URL is used as is.
  readonly sttUrl: Option.Option<string>
  readonly ttsUrl: Option.Option<string>
  readonly whisperBin: string
  readonly whisperModel: string
  readonly kokoroDir: string
  readonly langDefault: SynthesizeLanguage
  // Binary of the Python venv that runs tts_server.py (services/voice/python, synced with uv).
  readonly ttsCommand: string
  readonly ttsCwd: string
  // Environment of the sidecar children: an allowlist, never the whole process env.
  readonly childEnv: Readonly<Record<string, string>>
}

// Same rule as the core: unset and blank both take the default.
const setting = <A>(name: string, read: (value: string) => A, fallback: A): Config.Config<A> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => (value.trim() === "" ? fallback : read(value.trim()))),
  )

const optionalUrl = (name: string): Config.Config<Option.Option<string>> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => (value.trim() === "" ? Option.none() : Option.some(value.trim()))),
  )

const APP_VOICE_DIR = join(homedir(), ".app", "voice")

// src/ and dist/ sit at the same depth, so this reaches services/voice from both.
const VOICE_ROOT = fileURLToPath(new URL("../", import.meta.url))

const isLanguage = Schema.is(SynthesizeLanguage)

export const VoiceConfig = Config.all({
  sttUrl: optionalUrl("VOICE_STT_URL"),
  ttsUrl: optionalUrl("VOICE_TTS_URL"),
  whisperBin: setting(
    "WHISPER_BIN",
    (value) => value,
    join(APP_VOICE_DIR, "whisper.cpp", "build", "bin", "whisper-server"),
  ),
  whisperModel: setting(
    "WHISPER_MODEL",
    (value) => value,
    join(APP_VOICE_DIR, "whisper.cpp", "models", "ggml-large-v3-turbo.bin"),
  ),
  kokoroDir: setting("KOKORO_DIR", (value) => value, join(APP_VOICE_DIR, "kokoro")),
  path: Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin")),
  langDefault: setting("VOICE_LANG_DEFAULT", (value) => (isLanguage(value) ? value : "pt"), "pt" as const),
}).pipe(
  Config.map(
    ({ path, ...values }): VoiceConfigShape => ({
      ...values,
      ttsCommand: join(VOICE_ROOT, "python", ".venv", "bin", "uvicorn"),
      ttsCwd: join(VOICE_ROOT, "python"),
      childEnv: { PATH: path, HOME: homedir() },
    }),
  ),
)
