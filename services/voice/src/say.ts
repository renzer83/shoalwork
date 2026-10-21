import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VoiceError } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { SpawnProcess } from "./supervisor.js"
import { pcmFromWav } from "./wav.js"

// macOS `say` fallback for Portuguese when the TTS sidecar is down. `-o -` is refused by macOS
// ("Opening output file failed"), so the audio goes to a temp file. The text goes last, after `--`.
export const SAY_VOICE_PT = "Luciana"
export const SAY_RATE = 180
export const SAY_SAMPLE_RATE = 24_000

export const buildSayArgs = (text: string, outFile: string): ReadonlyArray<string> => [
  "-v",
  SAY_VOICE_PT,
  "-r",
  String(SAY_RATE),
  "--file-format=WAVE",
  `--data-format=LEI16@${SAY_SAMPLE_RATE}`,
  "-o",
  outFile,
  "--",
  text,
]

const run = (
  command: string,
  args: ReadonlyArray<string>,
  spawnProcess: SpawnProcess,
): Effect.Effect<void, VoiceError> =>
  Effect.callback<void, VoiceError>((resume) => {
    let child: ReturnType<SpawnProcess>
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    } catch (cause) {
      resume(Effect.fail(new VoiceError({ op: "tts", reason: `say spawn failed: ${String(cause)}` })))
      return
    }
    child.once("error", () => resume(Effect.fail(new VoiceError({ op: "tts", reason: "say spawn failed" }))))
    child.once("close", (code: number | null) => {
      if (code === 0) resume(Effect.void)
      else resume(Effect.fail(new VoiceError({ op: "tts", reason: `say exited with ${code ?? "signal"}` })))
    })
  })

// PCM s16le mono 24 kHz of the text, read back from a temp WAV that is always removed.
export const sayPcm = (text: string, spawnProcess: SpawnProcess): Effect.Effect<Uint8Array, VoiceError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "shoalwork-say-")),
      catch: () => new VoiceError({ op: "tts", reason: "temp dir failed" }),
    }),
    (dir) =>
      Effect.gen(function* () {
        const outFile = join(dir, "speech.wav")
        yield* run("say", buildSayArgs(text, outFile), spawnProcess)
        const wav = yield* Effect.tryPromise({
          try: () => readFile(outFile),
          catch: () => new VoiceError({ op: "tts", reason: "say produced no file" }),
        })
        const pcm = pcmFromWav(new Uint8Array(wav))
        if (pcm === undefined)
          return yield* Effect.fail(new VoiceError({ op: "tts", reason: "say output is not WAV" }))
        return pcm
      }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
