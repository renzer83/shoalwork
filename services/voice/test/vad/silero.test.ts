import { it } from "@effect/vitest"
import { Effect } from "effect"
import { Tensor } from "onnxruntime-node"
import { describe, expect } from "vitest"
import {
  loadSileroSession,
  makeSileroVad,
  SileroVad,
  SileroVadLive,
  type VadSession,
} from "../../src/vad/silero.js"

type Feeds = Record<string, Tensor>
// How the fake treats `sr`: accepts both shapes, refuses the scalar, refuses both, or refuses with an unrelated rank error.
type SrBehavior = "any" | "vector-only" | "neither" | "unrelated"
type Call = {
  readonly input: Float32Array
  readonly inputDims: ReadonlyArray<number>
  readonly state: Float32Array
  readonly srDims: ReadonlyArray<number>
  readonly sr: bigint | undefined
}

// A session that answers like Silero: prob from the loudest sample, and a new state that counts the calls.
const fakeSession = (
  overrides: Partial<Pick<VadSession, "inputNames" | "outputNames" | "inputMetadata">> = {},
  srBehavior: SrBehavior = "any",
): {
  readonly session: VadSession
  readonly calls: Call[]
  readonly attempts: Array<ReadonlyArray<number>>
  readonly released: () => number
} => {
  const calls: Call[] = []
  const attempts: Array<ReadonlyArray<number>> = []
  let released = 0
  const session: VadSession = {
    inputNames: ["input", "state", "sr"],
    outputNames: ["output", "stateN"],
    inputMetadata: [],
    ...overrides,
    release: async () => {
      released += 1
    },
    run: async (feeds) => {
      const typed = feeds as Feeds
      const input = typed.input
      const state = typed.state
      const sr = typed.sr
      const srMode = srBehavior
      if (input === undefined || state === undefined || sr === undefined) throw new Error("missing feed")
      attempts.push([...sr.dims])
      if (srMode === "vector-only" && sr.dims.length === 0)
        throw new Error("Invalid rank for input: sr Got: 0 Expected: 1")
      if (srMode === "neither") throw new Error("Invalid rank for input: sr Got: 2 Expected: 1")
      if (srMode === "unrelated") throw new Error("rank of the state is wrong")
      calls.push({
        input: Float32Array.from(input.data as Float32Array),
        inputDims: [...input.dims],
        state: Float32Array.from(state.data as Float32Array),
        srDims: [...sr.dims],
        sr: (sr.data as BigInt64Array)[0],
      })
      const prev = (state.data as Float32Array)[0] ?? 0
      const nextState = new Float32Array(256).fill(prev + 1)
      const peak = Math.max(...Array.from(input.data as Float32Array, Math.abs))
      return {
        output: new Tensor("float32", Float32Array.of(peak), [1, 1]),
        stateN: new Tensor("float32", nextState, [2, 1, 128]),
      }
    },
  }
  return { session, calls, attempts, released: () => released }
}

const frameOf = (value: number): Int16Array => new Int16Array(512).fill(value)

describe("makeSileroVad", () => {
  it.effect("feeds the 64-sample context plus the frame, with the rate and the state", () =>
    Effect.gen(function* () {
      const { session, calls } = fakeSession()
      const vad = yield* makeSileroVad(session)

      const first = yield* vad.prob(frameOf(16384))
      yield* vad.prob(frameOf(8192))

      expect(first).toBeCloseTo(0.5)
      expect(calls[0]?.inputDims).toEqual([1, 576])
      expect(calls[0]?.sr).toBe(16000n)
      expect(calls[0]?.state).toHaveLength(256)
      // The second call starts with the last 64 samples of the first frame, then its own samples.
      expect(calls[1]?.input[0]).toBeCloseTo(0.5)
      expect(calls[1]?.input[63]).toBeCloseTo(0.5)
      expect(calls[1]?.input[64]).toBeCloseTo(0.25)
    }),
  )

  it.effect("carries the recurrent state between calls and zeroes it on reset", () =>
    Effect.gen(function* () {
      const { session, calls } = fakeSession()
      const vad = yield* makeSileroVad(session)

      yield* vad.prob(frameOf(100))
      yield* vad.prob(frameOf(100))
      yield* vad.prob(frameOf(100))
      yield* vad.reset()
      yield* vad.prob(frameOf(100))

      expect(calls.map((c) => c.state[0])).toEqual([0, 1, 2, 0])
      expect(calls[3]?.input[0]).toBe(0)
    }),
  )

  it.effect("uses a bare [1, 512] input when the model declares that width", () =>
    Effect.gen(function* () {
      const { session, calls } = fakeSession({
        inputMetadata: [{ name: "input", isTensor: true, type: "float32", shape: [1, 512] }],
      })
      const vad = yield* makeSileroVad(session)

      yield* vad.prob(frameOf(100))

      expect(calls[0]?.inputDims).toEqual([1, 512])
    }),
  )

  it.effect("flips the sr shape when the runtime refuses the scalar form, and keeps the new form", () =>
    Effect.gen(function* () {
      const { session, calls, attempts } = fakeSession({}, "vector-only")
      const vad = yield* makeSileroVad(session)

      yield* vad.prob(frameOf(100))
      yield* vad.prob(frameOf(100))

      expect(calls.map((c) => c.srDims)).toEqual([[1], [1]])
      // First call: scalar refused, vector worked. Second call goes straight to the vector.
      expect(attempts).toEqual([[], [1], [1]])
    }),
  )

  it.effect("does not remember the other sr form until a retry has worked", () =>
    Effect.gen(function* () {
      const { session, attempts } = fakeSession({}, "neither")
      const vad = yield* makeSileroVad(session)

      expect((yield* Effect.flip(vad.prob(frameOf(100)))).op).toBe("vad")
      expect((yield* Effect.flip(vad.prob(frameOf(100)))).op).toBe("vad")

      // Each call starts with the scalar again: the failed retry did not flip anything.
      expect(attempts).toEqual([[], [1], [], [1]])
    }),
  )

  it.effect("does not retry on a rank error that is not about sr", () =>
    Effect.gen(function* () {
      const { session, attempts } = fakeSession({}, "unrelated")
      const vad = yield* makeSileroVad(session)

      yield* Effect.flip(vad.prob(frameOf(100)))

      expect(attempts).toEqual([[]])
    }),
  )

  it.effect("rejects a model whose I/O names differ, listing what it found", () =>
    Effect.gen(function* () {
      const { session } = fakeSession({
        inputNames: ["input", "h", "c"],
        outputNames: ["speech_probs", "hn", "cn"],
      })

      const error = yield* Effect.flip(makeSileroVad(session))

      expect(error.op).toBe("vad")
      expect(error.reason).toContain("missing state, sr, output, stateN")
      expect(error.reason).toContain("speech_probs")
    }),
  )

  it.effect("rejects a frame that is not 512 samples", () =>
    Effect.gen(function* () {
      const { session, calls } = fakeSession()
      const vad = yield* makeSileroVad(session)

      const error = yield* Effect.flip(vad.prob(new Int16Array(100)))

      expect(error.reason).toContain("512")
      expect(calls).toHaveLength(0)
    }),
  )
})

describe("SileroVadLive", () => {
  const use = (session: VadSession) =>
    Effect.gen(function* () {
      const vad = yield* SileroVad
      return yield* vad.prob(frameOf(100))
    }).pipe(Effect.provide(SileroVadLive("/models/silero.onnx", () => Effect.succeed(session))))

  it.effect("releases the ONNX session exactly once when the layer's scope closes", () =>
    Effect.gen(function* () {
      const { session, released } = fakeSession()

      yield* use(session)

      expect(released()).toBe(1)
    }),
  )

  it.effect("releases the session even when the use fails", () =>
    Effect.gen(function* () {
      const { session, released } = fakeSession({}, "neither")

      yield* Effect.flip(use(session))

      expect(released()).toBe(1)
    }),
  )

  it.effect("ignores a release that rejects", () =>
    Effect.gen(function* () {
      const { session } = fakeSession()
      let attempts = 0
      const stubborn: VadSession = {
        ...session,
        release: async () => {
          attempts += 1
          throw new Error("native release failed")
        },
      }

      yield* use(stubborn)

      expect(attempts).toBe(1)
    }),
  )
})

describe("loadSileroSession", () => {
  it.effect(
    "names SILERO_MODEL and the file, but leaks neither the full path nor the ONNX Runtime message",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadSileroSession("/nonexistent-dir/private/silero_vad.onnx"))

        expect(error.op).toBe("vad")
        expect(error.reason).toContain("SILERO_MODEL")
        expect(error.reason).toContain("silero_vad.onnx")
        expect(error.reason).not.toContain("nonexistent-dir")
        expect(error.reason).not.toContain("private")
        expect(error.reason).not.toMatch(/Load model|failed/i)
      }),
  )
})
