import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { runProcess, spawnProcess } from "../src/process.js"
import { gitEnv, psCommands } from "./helpers.js"

const opts = { cwd: process.cwd(), env: gitEnv() }

// Poll ps for a bounded time: the kernel may take a moment to reap after the group is killed.
const waitGone = (needle: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20; i++) {
      if (!psCommands().includes(needle)) return true
      yield* Effect.sleep("50 millis")
    }
    return false
  })

// Fails the test if the needle never shows up: proves the kill tests are not vacuous.
const waitPresent = (needle: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 40; i++) {
      if (psCommands().includes(needle)) return
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.die(`process never appeared: ${needle}`)
  })

describe("runProcess", () => {
  it.live("captures stdout, stderr and exit code", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["sh", "-c", "echo hi; echo err 1>&2; exit 3"], opts)
      expect(r.stdout.trim()).toBe("hi")
      expect(r.stderr.trim()).toBe("err")
      expect(r.exitCode).toBe(3)
      expect(r.timedOut).toBe(false)
    }),
  )

  it.live("flags timedOut and kills the process after timeoutMs", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["sleep", "5.11"], { ...opts, timeoutMs: 200 })
      expect(r.timedOut).toBe(true)
      expect(r.exitCode).not.toBe(0)
      expect(r.durationMs).toBeLessThan(4000)
      expect(yield* waitGone("sleep 5.11")).toBe(true)
    }),
  )

  it.live("kills the whole process group, leaving no orphan sleep", () =>
    Effect.gen(function* () {
      const [r] = yield* Effect.all(
        [
          runProcess(["sh", "-c", "sleep 30.77 & sleep 30.77"], { ...opts, timeoutMs: 2000 }),
          // Must observe the children alive before the timeout fires.
          waitPresent("sleep 30.77"),
        ],
        { concurrency: "unbounded" },
      )
      expect(r.timedOut).toBe(true)
      expect(yield* waitGone("sleep 30.77")).toBe(true)
    }),
  )

  it.live(
    "escalates to SIGKILL after 5s when the process ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const [r] = yield* Effect.all(
          [
            runProcess(["sh", "-c", 'trap "" TERM; sleep 60.17'], { ...opts, timeoutMs: 500 }),
            waitPresent("sleep 60.17"),
          ],
          { concurrency: "unbounded" },
        )
        expect(r.timedOut).toBe(true)
        expect(r.durationMs).toBeGreaterThanOrEqual(5000)
        expect(r.exitCode).toBe(137)
        expect(yield* waitGone("sleep 60.17")).toBe(true)
      }),
    20_000,
  )

  it.live("feeds stdin and closes it", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["cat"], { ...opts, stdin: "from stdin" })
      expect(r.stdout).toBe("from stdin")
      expect(r.exitCode).toBe(0)
    }),
  )

  it.live("closes stdin by default so readers do not hang", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["cat"], { ...opts, timeoutMs: 3000 })
      expect(r.timedOut).toBe(false)
    }),
  )

  it.live("passes only the given env, never the parent's", () =>
    Effect.gen(function* () {
      process.env.SECRET_X = "leaked"
      const r = yield* runProcess(["sh", "-c", `printf "%s|%s" "$FOO" "\${SECRET_X-unset}"`], {
        cwd: opts.cwd,
        env: { PATH: process.env.PATH ?? "", FOO: "bar" },
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete process.env.SECRET_X
          }),
        ),
      )
      expect(r.stdout).toBe("bar|unset")
    }),
  )

  it.live("fails with TankError when the binary does not exist", () =>
    Effect.gen(function* () {
      const e = yield* runProcess(["definitely-not-a-binary-xyz"], opts).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      expect(e.op).toBe("spawn")
    }),
  )

  it.live("fails with TankError on an empty command", () =>
    Effect.gen(function* () {
      const e = yield* runProcess([], opts).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
    }),
  )
})

describe("spawnProcess", () => {
  it.live("streams stdout and stderr lines and reports the exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const p = yield* spawnProcess(["sh", "-c", "echo a; echo b; echo e 1>&2; exit 2"], opts)
        const [out, err, code] = yield* Effect.all(
          [Stream.runCollect(p.stdout), Stream.runCollect(p.stderr), p.exitCode],
          { concurrency: "unbounded" },
        )
        expect(out).toEqual(["a", "b"])
        expect(err).toEqual(["e"])
        expect(code).toBe(2)
      }),
    ),
  )

  it.live("delivers lines written to stdin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const p = yield* spawnProcess(["sh", "-c", "read x; echo got:$x"], opts)
        yield* p.writeStdin("hello\n")
        expect(yield* Stream.runCollect(p.stdout)).toEqual(["got:hello"])
        expect(yield* p.exitCode).toBe(0)
      }),
    ),
  )

  it.live("kills the process group when the scope closes", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const p = yield* spawnProcess(["sh", "-c", "sleep 40.31 & sleep 40.31"], opts)
          expect(p.pid).toBeGreaterThan(0)
          yield* Effect.sleep("100 millis")
          expect(psCommands()).toContain("sleep 40.31")
        }),
      )
      expect(yield* waitGone("sleep 40.31")).toBe(true)
    }),
  )

  it.live("kill() terminates the process and exitCode reflects the signal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const p = yield* spawnProcess(["sleep", "50.9"], opts)
        yield* p.kill("SIGTERM")
        expect(yield* p.exitCode).toBe(143)
      }),
    ),
  )

  it.live("closeStdin lets a stdin reader finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const p = yield* spawnProcess(["cat"], opts)
        yield* p.writeStdin("x\n")
        yield* p.closeStdin()
        expect(yield* Stream.runCollect(p.stdout)).toEqual(["x"])
        expect(yield* p.exitCode).toBe(0)
      }),
    ),
  )

  it.live("reaps background children that outlive the leader when the scope closes", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const p = yield* spawnProcess(["sh", "-c", "nohup sleep 30.91 >/dev/null 2>&1 & exit 0"], opts)
          expect(yield* p.exitCode).toBe(0)
          // Leader is gone, the orphan is still alive: this is what the finalizer must clean up.
          yield* waitPresent("sleep 30.91")
        }),
      )
      expect(yield* waitGone("sleep 30.91")).toBe(true)
    }),
  )

  it.live(
    "scope close escalates to SIGKILL for a process group that ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const started = Date.now()
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* spawnProcess(["sh", "-c", 'trap "" TERM; sleep 60.18'], opts)
            yield* waitPresent("sleep 60.18")
          }),
        )
        expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
        expect(yield* waitGone("sleep 60.18")).toBe(true)
      }),
    20_000,
  )
})
