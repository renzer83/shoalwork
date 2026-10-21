import type { Writable } from "node:stream"
import { VoiceError } from "@shoalwork/contracts"
import { Context, Effect, Layer, Stream } from "effect"
import {
  type AudioProcess,
  type AudioSpawn,
  defaultAudioSpawn,
  missingBinary,
  spawnAudioProcess,
} from "./process.js"

export type PlayOptions = {
  // Sample rate of the PCM (s16le mono); Kokoro and `say` produce 24 kHz.
  readonly rate: number
}

export type PlaybackShape = {
  // Resolves when the audio has been played, or was cut by `stop`. A new `play` stops the previous one.
  readonly play: (
    pcm: Stream.Stream<Uint8Array, VoiceError>,
    options: PlayOptions,
  ) => Effect.Effect<void, VoiceError>
  // SIGTERM to the process group of the current playback; a no-op when nothing is playing.
  readonly stop: () => Effect.Effect<void>
}

export class Playback extends Context.Service<Playback, PlaybackShape>()("@shoalwork/Playback") {}

export const PLAY_COMMAND = "play"

export const playArgs = (rate: number): ReadonlyArray<string> => [
  "-q",
  "-t",
  "raw",
  "-r",
  String(rate),
  "-c",
  "1",
  "-b",
  "16",
  "-e",
  "signed-integer",
  "-",
]

export type PlaybackOptions = {
  readonly command?: string
  readonly spawnProcess?: AudioSpawn
  readonly env: Readonly<Record<string, string>>
}

// Resolves once the chunk has been flushed to the pipe: that is the back-pressure.
const write = (stdin: Writable, chunk: Uint8Array, proc: AudioProcess): Effect.Effect<void, VoiceError> =>
  Effect.callback<void, VoiceError>((resume) => {
    stdin.write(chunk, (cause) => {
      // A broken pipe after our own SIGTERM is the stop working, not a failure.
      if (cause === null || cause === undefined || proc.terminated()) resume(Effect.void)
      else resume(Effect.fail(new VoiceError({ op: "playback", reason: "audio pipe closed" })))
    })
  })

export const makePlayback = (options: PlaybackOptions): PlaybackShape => {
  const command = options.command ?? PLAY_COMMAND
  const spawnProcess = options.spawnProcess ?? defaultAudioSpawn
  let current: AudioProcess | undefined

  const stop = (): Effect.Effect<void> =>
    Effect.suspend(() => (current === undefined ? Effect.void : current.terminate))

  const play = (
    pcm: Stream.Stream<Uint8Array, VoiceError>,
    playOptions: PlayOptions,
  ): Effect.Effect<void, VoiceError> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* stop()
        const proc = yield* spawnAudioProcess("playback", spawnProcess, command, playArgs(playOptions.rate), {
          env: { ...options.env },
          stdio: ["pipe", "ignore", "pipe"],
        })
        current = proc
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (current === proc) current = undefined
          }),
        )
        const stdin = proc.child.stdin
        if (stdin === null)
          return yield* Effect.fail(new VoiceError({ op: "playback", reason: `${command} has no stdin` }))
        stdin.on("error", () => undefined)

        const exit = Effect.promise(() => proc.exit)
        const feed = Stream.runForEach(pcm, (chunk) => write(stdin, chunk, proc)).pipe(
          Effect.andThen(Effect.sync(() => stdin.end())),
          Effect.andThen(exit),
        )
        // Whichever ends first decides: the process dying (stop, crash) cuts the feed short.
        const info = yield* Effect.raceFirst(feed, exit)
        if (info.spawnError !== undefined)
          return yield* Effect.fail(
            new VoiceError({
              op: "playback",
              reason:
                info.spawnError === "ENOENT" ? missingBinary(command) : `${command}: ${info.spawnError}`,
            }),
          )
        if (proc.terminated() || info.code === 0) return
        const detail = proc.stderrTail()
        return yield* Effect.fail(
          new VoiceError({
            op: "playback",
            reason: `${command} exited with ${info.code ?? info.signal ?? "unknown"}${detail === "" ? "" : `: ${detail}`}`,
          }),
        )
      }),
    )

  return { play, stop }
}

export const PlaybackLive = (options: PlaybackOptions): Layer.Layer<Playback> =>
  Layer.succeed(Playback, makePlayback(options))
