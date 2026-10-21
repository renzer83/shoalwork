import { basename } from "node:path"
import { VoiceError } from "@shoalwork/contracts"
import { Context, Effect, Layer, type Scope, Semaphore } from "effect"
import { InferenceSession, Tensor } from "onnxruntime-node"
import { FRAME_SAMPLES, SAMPLE_RATE } from "../audio/frame.js"

export type VadShape = {
  // Speech probability of one 512-sample frame. The recurrent state carries over between calls.
  readonly prob: (frame: Int16Array) => Effect.Effect<number, VoiceError>
  // Zeroes the recurrent state: call it between unrelated recordings.
  readonly reset: () => Effect.Effect<void>
}

export class SileroVad extends Context.Service<SileroVad, VadShape>()("@shoalwork/SileroVad") {}

// Silero v5/v6 (snakers4/silero-vad): the model reads the last 64 samples of the previous chunk in front of the
// new 512, so `input` is [1, 576] at 16 kHz. Recurrent state is [2, 1, 128].
export const CONTEXT_SAMPLES = 64
const STATE_SIZE = 2 * 1 * 128
const INPUT_NAMES = ["input", "state", "sr"] as const
const OUTPUT_NAMES = ["output", "stateN"] as const
// ONNX Runtime wording for a wrong `sr` rank.
const SR_RANK_ERROR = /Invalid rank for input: sr\b/

// What the VAD needs from an ONNX Runtime session; the real `InferenceSession` fits it.
export type VadSession = Pick<
  InferenceSession,
  "inputNames" | "outputNames" | "inputMetadata" | "run" | "release"
>

const fail = (reason: string): VoiceError => new VoiceError({ op: "vad", reason })

const missing = (found: ReadonlyArray<string>, wanted: ReadonlyArray<string>): ReadonlyArray<string> =>
  wanted.filter((name) => !found.includes(name))

// Input length the model declares for `input` when it is a fixed number (512 means "no context rows").
const declaredWidth = (session: VadSession): number | undefined => {
  const meta = session.inputMetadata.find((m) => m.name === "input")
  if (meta === undefined || !meta.isTensor) return undefined
  const width = meta.shape[meta.shape.length - 1]
  return typeof width === "number" && width > 0 ? width : undefined
}

// Checks the I/O names first (the names in the task text were UNVERIFIED), then wires the recurrent loop.
export const makeSileroVad = (session: VadSession): Effect.Effect<VadShape, VoiceError> =>
  Effect.gen(function* () {
    const lacking = [
      ...missing(session.inputNames, INPUT_NAMES),
      ...missing(session.outputNames, OUTPUT_NAMES),
    ]
    if (lacking.length > 0)
      return yield* Effect.fail(
        fail(
          `unexpected silero model I/O (missing ${lacking.join(", ")}); inputs [${session.inputNames.join(", ")}] outputs [${session.outputNames.join(", ")}]`,
        ),
      )
    const width = declaredWidth(session)
    const context = width === FRAME_SAMPLES ? 0 : CONTEXT_SAMPLES
    const gate = yield* Semaphore.make(1)

    let state = new Float32Array(STATE_SIZE)
    let tail = new Float32Array(context)
    // `sr` is a scalar in some exports and a one-element vector in others: flip once if ONNX Runtime refuses it.
    let scalarSr = true

    const infer = (input: Float32Array): Effect.Effect<number, VoiceError> =>
      Effect.tryPromise({
        try: async () => {
          const run = (scalar: boolean) =>
            session.run({
              input: new Tensor("float32", input, [1, input.length]),
              state: new Tensor("float32", state, [2, 1, 128]),
              sr: new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), scalar ? [] : [1]),
            })
          const out = await run(scalarSr).catch(async (cause: unknown) => {
            if (!SR_RANK_ERROR.test(String(cause))) throw cause
            // The other form is remembered only once it has actually worked.
            const retried = await run(!scalarSr)
            scalarSr = !scalarSr
            return retried
          })
          const prob = out.output?.data
          const next = out.stateN?.data
          if (!(prob instanceof Float32Array) || prob.length < 1 || !(next instanceof Float32Array))
            throw new Error("silero output has an unexpected type")
          if (next.length !== STATE_SIZE) throw new Error("silero state has an unexpected size")
          state = Float32Array.from(next)
          return prob[0] ?? 0
        },
        catch: (cause) => fail(`inference failed: ${cause instanceof Error ? cause.message : String(cause)}`),
      })

    const prob = (frame: Int16Array): Effect.Effect<number, VoiceError> =>
      Effect.suspend(() => {
        if (frame.length !== FRAME_SAMPLES)
          return Effect.fail(fail(`frame must have ${FRAME_SAMPLES} samples, got ${frame.length}`))
        const input = new Float32Array(context + FRAME_SAMPLES)
        input.set(tail, 0)
        for (let i = 0; i < FRAME_SAMPLES; i++) input[context + i] = (frame[i] ?? 0) / 32768
        return infer(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              tail = input.slice(input.length - context)
            }),
          ),
        )
      }).pipe(gate.withPermits(1))

    const reset = (): Effect.Effect<void> =>
      Effect.sync(() => {
        state = new Float32Array(STATE_SIZE)
        tail = new Float32Array(context)
      }).pipe(gate.withPermits(1))

    return { prob, reset }
  })

// The reason names the setting and the file name, never the full path or the raw ONNX Runtime message.
export const loadSileroSession = (modelPath: string): Effect.Effect<VadSession, VoiceError> =>
  Effect.tryPromise({
    try: () => InferenceSession.create(modelPath),
    catch: () => fail(`silero model could not be loaded: check SILERO_MODEL (file ${basename(modelPath)})`),
  })

// The native session is released when the scope closes.
export const acquireSileroSession = (
  modelPath: string,
  load: (path: string) => Effect.Effect<VadSession, VoiceError> = loadSileroSession,
): Effect.Effect<VadSession, VoiceError, Scope.Scope> =>
  Effect.acquireRelease(load(modelPath), (session) =>
    Effect.tryPromise({ try: () => session.release(), catch: (cause) => cause }).pipe(Effect.ignore),
  )

export const SileroVadLive = (
  modelPath: string,
  load: (path: string) => Effect.Effect<VadSession, VoiceError> = loadSileroSession,
): Layer.Layer<SileroVad, VoiceError> =>
  Layer.effect(SileroVad, acquireSileroSession(modelPath, load).pipe(Effect.flatMap(makeSileroVad)))
