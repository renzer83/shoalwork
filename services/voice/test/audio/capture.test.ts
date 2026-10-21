import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { afterAll, describe, expect } from "vitest"
import { makeCapture, REC_ARGS } from "../../src/audio/capture.js"
import { FRAME_MS } from "../../src/audio/frame.js"
import { DEFAULT_SEGMENT_CONFIG, segment } from "../../src/vad/segmenter.js"
import { failingVad } from "../vad/helpers.js"
import { isAlive, makeFakes } from "./fakes.js"

const fakes = makeFakes()
afterAll(() => fakes.cleanup())

const env = { PATH: "/usr/bin:/bin", HOME: "/home/fake" }
const capture = (extra: Record<string, string> = {}, audioDev?: string) =>
  makeCapture({ spawnProcess: fakes.rec, env: { ...env, ...extra }, audioDev })

describe("Capture", () => {
  it.live("slices the byte stream into 512-sample frames with a running timestamp", () =>
    Effect.gen(function* () {
      const frames = yield* Stream.runCollect(capture({ FAKE_FRAMES: "5" }).frames())

      expect(frames).toHaveLength(5)
      expect(frames.map((f) => f.pcm.length)).toEqual([512, 512, 512, 512, 512])
      expect(frames.map((f) => f.pcm[0])).toEqual([1, 2, 3, 4, 5])
      expect(frames.map((f) => f.pcm[511])).toEqual([1, 2, 3, 4, 5])
      expect(frames.map((f) => f.t)).toEqual([0, 1, 2, 3, 4].map((i) => i * FRAME_MS))
    }),
  )

  it.live("spawns rec with the raw 16 kHz mono argv and drops a trailing partial frame", () =>
    Effect.gen(function* () {
      const before = fakes.calls.length
      const frames = yield* Stream.runCollect(capture({ FAKE_FRAMES: "2", FAKE_EXTRA_BYTES: "300" }).frames())

      expect(frames).toHaveLength(2)
      const call = fakes.calls[before]
      expect(call?.args).toEqual(REC_ARGS)
      expect(call?.args.join(" ")).toBe("-q -t raw -r 16000 -c 1 -b 16 -e signed-integer -L -")
      expect(call?.options.detached).toBe(true)
      expect(call?.options.shell).toBeUndefined()
    }),
  )

  it.live(
    "passes AUDIODEV to the child, reports the device and never leaks the rest of the environment",
    () =>
      Effect.gen(function* () {
        const before = fakes.calls.length
        const source = capture({ FAKE_FRAMES: "1" }, "Built-in Microphone")
        yield* Stream.runCollect(source.frames())

        expect(fakes.calls[before]?.options.env).toEqual({
          ...env,
          FAKE_FRAMES: "1",
          AUDIODEV: "Built-in Microphone",
        })
        expect(yield* source.device()).toBe("Built-in Microphone")
        expect(yield* capture({}, "  ").device()).toBe("default")
      }),
  )

  it.live("fails with a VoiceError that points at the microphone permission when rec exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Stream.runCollect(capture({ FAKE_MODE: "fail" }).frames()))

      expect(error.op).toBe("capture")
      expect(error.reason).toContain("exited with 2")
      expect(error.reason).toContain("can't open input device")
      expect(error.reason).toContain("System Settings › Privacy › Microphone")
    }),
  )

  it.live("fails with an install hint when the binary does not exist", () =>
    Effect.gen(function* () {
      const missing = makeCapture({ command: "shoalwork-no-such-rec", env })

      const error = yield* Effect.flip(Stream.runCollect(missing.frames()))

      expect(error.op).toBe("capture")
      expect(error.reason).toContain("shoalwork-no-such-rec not found")
      expect(error.reason).toContain("brew install sox")
    }),
  )

  it.live("kills the rec process group when the consumer stops early", () =>
    Effect.gen(function* () {
      const before = fakes.spawned.length
      const frames = yield* Stream.runCollect(capture({ FAKE_MODE: "forever" }).frames().pipe(Stream.take(2)))

      expect(frames).toHaveLength(2)
      const child = fakes.spawned[before]
      expect(child?.pid).toBeDefined()
      // The scope closed with the stream, so the SIGTERM was sent and waited for.
      expect(child?.signalCode).toBe("SIGTERM")
      expect(isAlive(child?.pid ?? 0)).toBe(false)
    }),
  )

  it.live("kills the rec process group when the VAD downstream fails", () =>
    Effect.gen(function* () {
      const before = fakes.spawned.length

      const error = yield* Effect.flip(
        Stream.runCollect(
          segment(capture({ FAKE_MODE: "forever" }).frames(), failingVad, DEFAULT_SEGMENT_CONFIG),
        ),
      )

      expect(error.op).toBe("vad")
      const child = fakes.spawned[before]
      expect(child?.signalCode).toBe("SIGTERM")
      expect(isAlive(child?.pid ?? 0)).toBe(false)
    }),
  )

  it.live("keeps only the tail of a very long stderr in the error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Stream.runCollect(capture({ FAKE_MODE: "noisy" }).frames()))

      expect(error.reason).toContain("exited with 1")
      expect(error.reason).toContain("END-MARK")
      expect(error.reason).not.toContain("x".repeat(2_001))
      expect(error.reason.length).toBeLessThan(2_300)
    }),
  )
})
