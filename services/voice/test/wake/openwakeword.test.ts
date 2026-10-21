import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { afterAll, describe, expect } from "vitest"
import { cooldownFilter, makeWakeWord, type WakeOptions } from "../../src/wake/openwakeword.js"
import { fakeCapture, framesWithMarkers, makeSidecarFake } from "./fakes.js"

const fake = makeSidecarFake()
afterAll(() => fake.cleanup())

const baseOptions = (mode: string): WakeOptions => ({
  command: "/nonexistent/python",
  script: "/nonexistent/wake_server.py",
  cwd: fake.dir,
  model: "hey_test",
  threshold: 0.5,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_MODE: mode },
})

const options = (mode: string, extra: Partial<WakeOptions> = {}): WakeOptions => ({
  ...baseOptions(mode),
  spawnProcess: fake.spawn,
  ...extra,
})

describe("WakeWord", () => {
  it.live("emits one detection per marker frame with the sidecar's name, score and t", () =>
    Effect.gen(function* () {
      // Markers at 0 and 1 s after the first one: 25 sidecar frames (2000 ms) apart, so cooldown lets both through.
      const frames = framesWithMarkers(33_280, [0, 32_000])
      const wake = makeWakeWord(fakeCapture(frames), options("detect"))

      const found = yield* Stream.runCollect(wake.detections())

      expect(found).toEqual([
        { name: "hey_test", score: 0.93, t: 0 },
        { name: "hey_test", score: 0.93, t: 2000 },
      ])
    }),
  )

  it.live("reframes 512-sample capture frames into 1280-sample sidecar frames", () =>
    Effect.gen(function* () {
      // Marker at sample 1280 is the first sample of the second sidecar frame (t = 80 ms). A 512-based split would miss it.
      const frames = framesWithMarkers(2_560, [1_280])
      const wake = makeWakeWord(fakeCapture(frames), options("detect"))

      const found = yield* Stream.runCollect(wake.detections())

      expect(found).toEqual([{ name: "hey_test", score: 0.93, t: 80 }])
    }),
  )

  it.live("drops detections within the 2 s cooldown of the last one let through", () =>
    Effect.gen(function* () {
      const frames = framesWithMarkers(2_560, [0, 1_280])
      const wake = makeWakeWord(fakeCapture(frames), options("detect"))

      const found = yield* Stream.runCollect(wake.detections())

      expect(found.map((d) => d.t)).toEqual([0])
    }),
  )

  it("cooldownFilter lets a detection through only when 2 s have passed since the last one let through", () => {
    const allow = cooldownFilter(2_000)
    const at = (t: number) => allow({ name: "hey_test", score: 0.9, t })

    expect([0, 80, 1_999, 2_000, 2_080, 4_000].map(at)).toEqual([true, false, false, true, false, true])
  })

  it.live(
    "starts the sidecar with argv for the model and threshold, in its own cwd, with an allowlisted env",
    () =>
      Effect.gen(function* () {
        const before = fake.calls.length
        const wake = makeWakeWord(
          fakeCapture(framesWithMarkers(512, [])),
          options("detect", { threshold: 0.7 }),
        )

        yield* Stream.runCollect(wake.detections())

        const call = fake.calls[before]
        expect(call?.command).toBe("/nonexistent/python")
        expect(call?.args).toEqual([
          "/nonexistent/wake_server.py",
          "--model",
          "hey_test",
          "--threshold",
          "0.7",
        ])
        expect(call?.env).toEqual({ PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_MODE: "detect" })
      }),
  )

  it.live("fails with the sidecar's stderr when it exits non-zero", () =>
    Effect.gen(function* () {
      const wake = makeWakeWord(fakeCapture(framesWithMarkers(2_560, [0]), true), options("crash"))

      const error = yield* Effect.flip(Stream.runCollect(wake.detections()))

      expect(error.op).toBe("wake")
      expect(error.reason).toContain("exited with 3")
      expect(error.reason).toContain("model broke")
    }),
  )

  it.live("fails with a VoiceError when the sidecar writes something that is not a sidecar message", () =>
    Effect.gen(function* () {
      const wake = makeWakeWord(fakeCapture(framesWithMarkers(512, []), true), options("garbage"))

      const error = yield* Effect.flip(Stream.runCollect(wake.detections()))

      expect(error.op).toBe("wake")
      expect(error.reason).toBe("unexpected sidecar output")
    }),
  )

  it.live("fails with the uv sync hint when the python binary does not exist", () =>
    Effect.gen(function* () {
      const wake = makeWakeWord(fakeCapture(framesWithMarkers(512, [])), {
        ...baseOptions("detect"),
        command: "/nonexistent/shoalwork-python",
      })

      const error = yield* Effect.flip(Stream.runCollect(wake.detections()))

      expect(error.op).toBe("wake")
      expect(error.reason).toContain("uv sync")
    }),
  )
})
