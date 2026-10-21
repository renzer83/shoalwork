import { VoiceError } from "@shoalwork/contracts"
import { Context, Effect, Layer, Stream } from "effect"
import { FRAME_BYTES, FRAME_MS, type Frame, frameFromBytes } from "./frame.js"
import { type AudioSpawn, defaultAudioSpawn, missingBinary, spawnAudioProcess } from "./process.js"

export type CaptureShape = {
  // One `rec` process per run of the stream; it dies when the stream ends or is interrupted.
  readonly frames: () => Stream.Stream<Frame, VoiceError>
  readonly device: () => Effect.Effect<string>
}

export class Capture extends Context.Service<Capture, CaptureShape>()("@shoalwork/Capture") {}

export const REC_COMMAND = "rec"
export const REC_ARGS: ReadonlyArray<string> = [
  "-q",
  "-t",
  "raw",
  "-r",
  "16000",
  "-c",
  "1",
  "-b",
  "16",
  "-e",
  "signed-integer",
  "-L",
  "-",
]

export type CaptureOptions = {
  readonly command?: string
  readonly spawnProcess?: AudioSpawn
  // Value of AUDIODEV for sox; blank or absent means the system default input.
  readonly audioDev?: string | undefined
  // Environment of the child: an allowlist (PATH, HOME, AUDIODRIVER), never the whole process env.
  readonly env: Readonly<Record<string, string>>
}

const MIC_HINT = "check System Settings › Privacy › Microphone"

// Splits an arbitrary byte stream into whole frames, carrying the remainder between chunks.
type Carry = { readonly rest: Uint8Array; readonly index: number }

const reframe = (carry: Carry, chunk: Uint8Array): readonly [Carry, ReadonlyArray<Frame>] => {
  const bytes = new Uint8Array(carry.rest.length + chunk.length)
  bytes.set(carry.rest, 0)
  bytes.set(chunk, carry.rest.length)
  const whole = Math.floor(bytes.length / FRAME_BYTES)
  const frames: Frame[] = []
  for (let i = 0; i < whole; i++)
    frames.push({ pcm: frameFromBytes(bytes, i * FRAME_BYTES), t: (carry.index + i) * FRAME_MS })
  return [{ rest: bytes.slice(whole * FRAME_BYTES), index: carry.index + whole }, frames]
}

export const makeCapture = (options: CaptureOptions): CaptureShape => {
  const command = options.command ?? REC_COMMAND
  const spawnProcess = options.spawnProcess ?? defaultAudioSpawn
  const audioDev = options.audioDev?.trim() ? options.audioDev.trim() : undefined
  const env = audioDev === undefined ? { ...options.env } : { ...options.env, AUDIODEV: audioDev }

  const frames = (): Stream.Stream<Frame, VoiceError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const proc = yield* spawnAudioProcess("capture", spawnProcess, command, REC_ARGS, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
        const stdout = proc.child.stdout
        if (stdout === null)
          return Stream.fail(new VoiceError({ op: "capture", reason: `${command} has no stdout` }))
        const pcm = Stream.fromAsyncIterable(
          stdout,
          () => new VoiceError({ op: "capture", reason: `${command} output could not be read` }),
        ).pipe(
          Stream.mapAccum<Carry, Uint8Array, Frame>(() => ({ rest: new Uint8Array(0), index: 0 }), reframe),
        )
        // After the last byte, a non-zero exit we did not cause is the failure (no mic permission, no device).
        const verdict = Stream.unwrap(
          Effect.promise(() => proc.exit).pipe(
            Effect.map((info) => {
              if (info.spawnError !== undefined)
                return Stream.fail(
                  new VoiceError({
                    op: "capture",
                    reason:
                      info.spawnError === "ENOENT"
                        ? missingBinary(command)
                        : `${command}: ${info.spawnError}`,
                  }),
                )
              if (proc.terminated() || info.code === 0) return Stream.empty
              const detail = proc.stderrTail()
              return Stream.fail(
                new VoiceError({
                  op: "capture",
                  reason: `${command} exited with ${info.code ?? info.signal ?? "unknown"}${detail === "" ? "" : `: ${detail}`}; ${MIC_HINT}`,
                }),
              )
            }),
          ),
        )
        return Stream.concat(pcm, verdict)
      }),
    )

  return { frames, device: () => Effect.succeed(audioDev ?? "default") }
}

export const CaptureLive = (options: CaptureOptions): Layer.Layer<Capture> =>
  Layer.succeed(Capture, makeCapture(options))
