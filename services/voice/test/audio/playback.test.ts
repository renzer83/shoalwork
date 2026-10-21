import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { afterAll, describe, expect } from "vitest"
import { makePlayback, playArgs } from "../../src/audio/playback.js"
import { isAlive, makeFakes } from "./fakes.js"

const fakes = makeFakes()
afterAll(() => fakes.cleanup())

const env = { PATH: "/usr/bin:/bin", HOME: "/home/fake" }
const playback = (extra: Record<string, string> = {}) =>
  makePlayback({ spawnProcess: fakes.play, env: { ...env, ...extra } })

const waitForChild = (index: number) =>
  Effect.gen(function* () {
    while (fakes.spawned[index]?.pid === undefined) yield* Effect.sleep(5)
    return fakes.spawned[index]
  })

describe("Playback", () => {
  it.live("pipes the PCM chunks to play with the raw argv for the given rate", () =>
    Effect.gen(function* () {
      const out = join(fakes.dir, "played.raw")
      const before = fakes.calls.length
      const chunks = [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6), new Uint8Array(70_000).fill(9)]

      yield* playback({ FAKE_OUT: out }).play(Stream.fromIterable(chunks), { rate: 24_000 })

      expect(fakes.calls[before]?.args).toEqual(playArgs(24_000))
      expect(fakes.calls[before]?.args.join(" ")).toBe("-q -t raw -r 24000 -c 1 -b 16 -e signed-integer -")
      const written = readFileSync(out)
      expect(written.length).toBe(4 + 2 + 70_000)
      expect([...written.subarray(0, 6)]).toEqual([1, 2, 3, 4, 5, 6])
    }),
  )

  it.live("fails with a VoiceError carrying play's stderr when it exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(playback({ FAKE_MODE: "exit1" }).play(Stream.never, { rate: 24_000 }))

      expect(error.op).toBe("playback")
      expect(error.reason).toContain("exited with 1")
      expect(error.reason).toContain("no output device")
    }),
  )

  it.live("fails with an install hint when the binary does not exist", () =>
    Effect.gen(function* () {
      const missing = makePlayback({ command: "shoalwork-no-such-play", env })

      const error = yield* Effect.flip(missing.play(Stream.never, { rate: 24_000 }))

      expect(error.op).toBe("playback")
      expect(error.reason).toContain("shoalwork-no-such-play not found")
    }),
  )

  it.live("stop() ends the playback with SIGTERM to the group and play resolves without error", () =>
    Effect.gen(function* () {
      const player = playback({ FAKE_MODE: "idle" })
      const index = fakes.spawned.length
      const fiber = yield* Effect.forkChild(player.play(Stream.never, { rate: 24_000 }))
      const child = yield* waitForChild(index)

      yield* player.stop()
      yield* Fiber.join(fiber)

      expect(child?.signalCode).toBe("SIGTERM")
      expect(isAlive(child?.pid ?? 0)).toBe(false)
    }),
  )

  it.live("stop() with nothing playing does nothing", () =>
    Effect.gen(function* () {
      yield* playback().stop()
    }),
  )

  it.live("a new play stops the one still running", () =>
    Effect.gen(function* () {
      const player = playback({ FAKE_MODE: "idle" })
      const index = fakes.spawned.length
      const first = yield* Effect.forkChild(player.play(Stream.never, { rate: 24_000 }))
      const firstChild = yield* waitForChild(index)

      const second = yield* Effect.forkChild(player.play(Stream.never, { rate: 24_000 }))
      yield* Fiber.join(first)
      const secondChild = yield* waitForChild(index + 1)
      yield* player.stop()
      yield* Fiber.join(second)

      expect(firstChild?.signalCode).toBe("SIGTERM")
      expect(secondChild?.signalCode).toBe("SIGTERM")
    }),
  )

  it.live("interrupting play kills the process", () =>
    Effect.gen(function* () {
      const player = playback({ FAKE_MODE: "idle" })
      const index = fakes.spawned.length
      const fiber = yield* Effect.forkChild(player.play(Stream.never, { rate: 24_000 }))
      const child = yield* waitForChild(index)

      yield* Fiber.interrupt(fiber)

      expect(child?.signalCode).toBe("SIGTERM")
      expect(isAlive(child?.pid ?? 0)).toBe(false)
    }),
  )

  it.live("fails with a VoiceError when play closes the pipe while audio is still being sent", () =>
    Effect.gen(function* () {
      const big = Stream.fromIterable(Array.from({ length: 40 }, () => new Uint8Array(65_536)))

      const error = yield* Effect.flip(playback({ FAKE_MODE: "early" }).play(big, { rate: 24_000 }))

      expect(error.op).toBe("playback")
      expect(error.reason).toMatch(/audio pipe closed|exited with 3/)
    }),
  )

  it.live("keeps only the tail of a very long stderr in the error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(playback({ FAKE_MODE: "noisy" }).play(Stream.never, { rate: 24_000 }))

      expect(error.reason).toContain("exited with 1")
      expect(error.reason).toContain("END-MARK")
      expect(error.reason).not.toContain("x".repeat(2_001))
      expect(error.reason.length).toBeLessThan(2_200)
    }),
  )
})
