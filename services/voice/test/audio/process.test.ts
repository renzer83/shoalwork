import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { afterAll, describe, expect, vi } from "vitest"
import { spawnAudioProcess } from "../../src/audio/process.js"
import { isAlive, makeFakes } from "./fakes.js"

const fakes = makeFakes()
afterAll(() => fakes.cleanup())

const env = { PATH: "/usr/bin:/bin", HOME: "/home/fake" }

describe("spawnAudioProcess", () => {
  it.live(
    "sends SIGTERM first and before any await, then escalates to SIGKILL for a process that ignores it",
    () =>
      Effect.gen(function* () {
        const kill = vi.spyOn(process, "kill")
        yield* Effect.gen(function* () {
          const proc = yield* spawnAudioProcess("playback", fakes.play, "play", [], {
            env: { ...env, FAKE_MODE: "stubborn" },
            stdio: ["pipe", "ignore", "pipe"],
          })
          const pid = proc.child.pid ?? 0
          // The handler is installed once the fake says so; before that SIGTERM would just kill it.
          while (!proc.stderrTail().includes("ready")) yield* Effect.sleep(5)
          const signalsTo = () =>
            kill.mock.calls.filter(([target]) => target === -pid).map(([, signal]) => signal)

          const fiber = Effect.runFork(proc.terminate)

          // Nothing has been awaited yet: the SIGTERM is already out, the SIGKILL is not.
          expect(signalsTo()).toEqual(["SIGTERM"])
          yield* Fiber.join(fiber)

          expect(signalsTo()).toEqual(["SIGTERM", "SIGKILL"])
          expect(proc.child.signalCode).toBe("SIGKILL")
          expect(isAlive(pid)).toBe(false)
        }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => kill.mockRestore())))
      }),
  )

  it.live("does not signal a process that already exited", () =>
    Effect.gen(function* () {
      const kill = vi.spyOn(process, "kill")
      yield* Effect.gen(function* () {
        const proc = yield* spawnAudioProcess("playback", fakes.play, "play", [], {
          env: { ...env, FAKE_MODE: "exit1" },
          stdio: ["pipe", "ignore", "pipe"],
        })
        yield* Effect.promise(() => proc.exit)
        const before = kill.mock.calls.length

        yield* proc.terminate

        expect(kill.mock.calls.length).toBe(before)
        expect(proc.terminated()).toBe(false)
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => kill.mockRestore())))
    }),
  )
})
