import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { makeTankLocal } from "../src/local.js"
import { runProcess } from "../src/process.js"
import { makeTankServer, type RunFn } from "../src/server.js"
import type { TankContext } from "../src/tank.js"
import { gitEnv, makeBot, psCommands, tempDir } from "./helpers.js"

const opts = { cwd: process.cwd(), env: gitEnv() }

// Polls instead of sampling once: the kernel may reap the killed process a moment after the group is signalled.
const waitGone = (needle: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (!psCommands().includes(needle)) return true
      yield* Effect.sleep("50 millis")
    }
    return false
  })

describe("runProcess maxOutputBytes", () => {
  it.live("stops an endless writer at the cap, kills it and flags the truncation", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["yes", "output-cap-probe"], { ...opts, maxOutputBytes: 1000 })
      expect(r.outputTruncated).toBe(true)
      expect(r.timedOut).toBe(false)
      expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(1000)
      expect(r.stdout.length).toBeGreaterThan(0)
      expect(yield* waitGone("yes output-cap-probe")).toBe(true)
    }),
  )

  it.live("counts stdout and stderr together", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["sh", "-c", "yes 1>&2"], { ...opts, maxOutputBytes: 500 })
      expect(r.outputTruncated).toBe(true)
      expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(500)
    }),
  )

  it.live("leaves output under the cap whole and unflagged", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["echo", "hello"], { ...opts, maxOutputBytes: 1000 })
      expect(r.stdout).toBe("hello\n")
      expect(r.outputTruncated).toBeUndefined()
      expect(r.exitCode).toBe(0)
    }),
  )

  it.live("does not change callers that set no cap", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' a"], opts)
      expect(r.stdout.length).toBe(200_000)
      expect(r.outputTruncated).toBeUndefined()
    }),
  )

  it.live("a timeout still reports timedOut, not truncation", () =>
    Effect.gen(function* () {
      const r = yield* runProcess(["sleep", "60.31"], { ...opts, maxOutputBytes: 1000, timeoutMs: 200 })
      expect(r.timedOut).toBe(true)
      expect(r.outputTruncated).toBeUndefined()
    }),
  )
})

describe("runProcess maxOutputBytes with multi-byte output", () => {
  it.live("cuts on a byte count and never inside a character", () =>
    Effect.gen(function* () {
      // 4-byte characters + newline = 5 bytes per line; 1002 leaves 2 bytes for a partial character at the cut.
      const r = yield* runProcess(["yes", "\u{1F600}"], { ...opts, maxOutputBytes: 1002 })
      expect(r.outputTruncated).toBe(true)
      expect(Buffer.byteLength(r.stdout)).toBe(1000)
      expect(r.stdout).not.toContain("\uFFFD")
      expect(r.stdout.endsWith("\n")).toBe(true)
    }),
  )
})

const root = tempDir()
const bot = makeBot("alice")
const ctxAt = (cwd: string): TankContext => ({
  botId: bot.id,
  botName: "alice",
  cwd,
  home: join(root, "home"),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
})

describe("Tank.exec forwards maxOutputBytes", () => {
  it.live("local mode stops an endless command at the cap", () =>
    Effect.gen(function* () {
      const cwd = join(root, "local-cwd")
      mkdirSync(cwd, { recursive: true })
      const tank = makeTankLocal({ root, baseEnv: { PATH: process.env.PATH } })
      const r = yield* tank.exec(ctxAt(cwd), ["yes"], { maxOutputBytes: 300 })
      expect(r.outputTruncated).toBe(true)
      expect(r.stdout.length).toBeLessThanOrEqual(300)
    }),
  )

  it.live("server mode hands the cap to the process runner", () =>
    Effect.gen(function* () {
      const seen: Array<number | undefined> = []
      const run: RunFn = (_cmd, runOpts) =>
        Effect.sync(() => {
          seen.push(runOpts.maxOutputBytes)
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false }
        })
      const tank = makeTankServer({ baseEnv: { PATH: "/usr/bin:/bin" }, sudo: true, run })
      yield* tank.exec(ctxAt("/home/bot-alice/work/s1"), ["echo", "hi"], { maxOutputBytes: 777 })
      yield* tank.exec(ctxAt("/home/bot-alice/work/s1"), ["echo", "hi"])
      expect(seen).toEqual([777, undefined])
    }),
  )
})
