import { createInterface } from "node:readline"
import type { Writable } from "node:stream"
import { VoiceError } from "@shoalwork/contracts"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Capture, type CaptureShape } from "../audio/capture.js"
import { bytesFromPcm, type Frame } from "../audio/frame.js"
import { type AudioSpawn, defaultAudioSpawn, spawnAudioProcess } from "../audio/process.js"

// openWakeWord takes 80 ms frames (research voice-local.md §3); the sidecar reads exactly these.
export const WAKE_FRAME_SAMPLES = 1280
// A detection within this many ms of the last one that got through is the same utterance.
export const WAKE_COOLDOWN_MS = 2_000

export const WakeDetection = Schema.Struct({
  name: Schema.String,
  score: Schema.Number,
  // Milliseconds since the first frame the sidecar received.
  t: Schema.Number,
})
export type WakeDetection = typeof WakeDetection.Type

// One line of wake_server.py stdout: the ready marker or a detection.
const SidecarLine = Schema.Union([
  Schema.Struct({ ready: Schema.Literal(true) }),
  Schema.Struct({ wake: Schema.String, score: Schema.Number, t: Schema.Number }),
])
const decodeSidecarLine = Schema.decodeUnknownEffect(SidecarLine)
type SidecarMessage = typeof SidecarLine.Type
type WakeLine = Extract<SidecarMessage, { readonly wake: string }>

const MISSING_SIDECAR = "wake sidecar not found: run uv sync in services/voice/python"

export type WakeOptions = {
  // Python binary and script, passed as argv (never through a shell).
  readonly command: string
  readonly script: string
  readonly cwd: string
  readonly model: string
  readonly threshold: number
  // Environment of the sidecar: an allowlist, never the whole process env.
  readonly env: Readonly<Record<string, string>>
  readonly spawnProcess?: AudioSpawn
  readonly cooldownMs?: number
}

export type WakeWordShape = {
  // One run starts one sidecar and one capture. The run ends when the capture ends (the sidecar then exits)
  // or when the stream is interrupted (the sidecar is killed).
  readonly detections: () => Stream.Stream<WakeDetection, VoiceError>
}

export class WakeWord extends Context.Service<WakeWord, WakeWordShape>()("@shoalwork/WakeWord") {}

// Lets a detection through unless it is within `ms` of the last one let through. `t` is the sidecar's clock.
export const cooldownFilter = (ms: number): ((detection: WakeDetection) => boolean) => {
  let last: number | undefined
  return (detection) => {
    if (last !== undefined && detection.t - last < ms) return false
    last = detection.t
    return true
  }
}

type Carry = { readonly rest: Int16Array }

// Splits capture frames (512 samples) into sidecar frames (1280 samples), carrying the remainder.
const reframe = (carry: Carry, frame: Frame): readonly [Carry, ReadonlyArray<Uint8Array>] => {
  const joined = new Int16Array(carry.rest.length + frame.pcm.length)
  joined.set(carry.rest, 0)
  joined.set(frame.pcm, carry.rest.length)
  const whole = Math.floor(joined.length / WAKE_FRAME_SAMPLES)
  const out: Uint8Array[] = []
  for (let i = 0; i < whole; i++)
    out.push(bytesFromPcm(joined.subarray(i * WAKE_FRAME_SAMPLES, (i + 1) * WAKE_FRAME_SAMPLES)))
  return [{ rest: joined.slice(whole * WAKE_FRAME_SAMPLES) }, out]
}

// Resolves once the chunk is flushed to the sidecar's stdin: that is the back-pressure. A closed pipe is not an
// error here: it means the sidecar is gone, and its exit is what the verdict reports (with its stderr).
const write = (stdin: Writable, chunk: Uint8Array): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    stdin.write(chunk, () => resume(Effect.void))
  })

const badLine = (): VoiceError => new VoiceError({ op: "wake", reason: "unexpected sidecar output" })

const parseLine = (line: string): Effect.Effect<SidecarMessage, VoiceError> =>
  Effect.try({ try: (): unknown => JSON.parse(line), catch: badLine }).pipe(
    Effect.flatMap((json) => decodeSidecarLine(json).pipe(Effect.mapError(badLine))),
  )

export const makeWakeWord = (capture: CaptureShape, options: WakeOptions): WakeWordShape => {
  const spawnProcess = options.spawnProcess ?? defaultAudioSpawn
  const cooldownMs = options.cooldownMs ?? WAKE_COOLDOWN_MS

  const detections = (): Stream.Stream<WakeDetection, VoiceError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const proc = yield* spawnAudioProcess(
          "wake",
          spawnProcess,
          options.command,
          [options.script, "--model", options.model, "--threshold", String(options.threshold)],
          { cwd: options.cwd, env: { ...options.env }, stdio: ["pipe", "pipe", "pipe"] },
        )
        const stdin = proc.child.stdin
        const stdout = proc.child.stdout
        if (stdin === null || stdout === null)
          return yield* Effect.fail(new VoiceError({ op: "wake", reason: "sidecar has no stdio" }))
        stdin.on("error", () => undefined)

        // Each stdout line is a sidecar message; only detections go on. The ready marker is informational.
        const lines = Stream.fromAsyncIterable<string, VoiceError>(
          createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY }),
          () => new VoiceError({ op: "wake", reason: "sidecar output could not be read" }),
        )
        const detected = lines.pipe(
          Stream.mapEffect(parseLine),
          Stream.filter((message): message is WakeLine => "wake" in message),
          Stream.map(
            (message): WakeDetection => ({ name: message.wake, score: message.score, t: message.t }),
          ),
          Stream.filter(cooldownFilter(cooldownMs)),
        )

        // After the last line: a non-zero exit we did not cause is the failure, with the sidecar's stderr.
        // A failed spawn is reported by `spawnFailure`, which does not wait for stdout to close.
        const verdict = Stream.unwrap(
          Effect.promise(() => proc.exit).pipe(
            Effect.map((info) => {
              if (info.spawnError !== undefined || proc.terminated() || info.code === 0) return Stream.empty
              const detail = proc.stderrTail()
              return Stream.fail(
                new VoiceError({
                  op: "wake",
                  reason: `wake sidecar exited with ${info.code ?? info.signal ?? "unknown"}${detail === "" ? "" : `: ${detail}`}`,
                }),
              )
            }),
          ),
        )

        const spawnFailure = Stream.drain(
          Stream.fromEffect(
            Effect.promise(() => proc.exit).pipe(
              Effect.flatMap((info) =>
                info.spawnError === undefined
                  ? Effect.void
                  : Effect.fail(
                      new VoiceError({
                        op: "wake",
                        reason:
                          info.spawnError === "ENOENT"
                            ? MISSING_SIDECAR
                            : `${options.command}: ${info.spawnError}`,
                      }),
                    ),
              ),
            ),
          ),
        )

        // Frames flow into the sidecar while detections come out; closing stdin lets the sidecar finish.
        const feed = Stream.runForEach(
          capture
            .frames()
            .pipe(Stream.mapAccum<Carry, Frame, Uint8Array>(() => ({ rest: new Int16Array(0) }), reframe)),
          (chunk) => write(stdin, chunk),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              stdin.end()
            }),
          ),
        )

        return Stream.merge(
          Stream.merge(Stream.concat(detected, verdict), Stream.drain(Stream.fromEffect(feed))),
          spawnFailure,
        )
      }),
    )

  return { detections }
}

export const WakeWordLive = (options: WakeOptions): Layer.Layer<WakeWord, never, Capture> =>
  Layer.effect(
    WakeWord,
    Effect.gen(function* () {
      const capture = yield* Capture
      return makeWakeWord(capture, options)
    }),
  )
