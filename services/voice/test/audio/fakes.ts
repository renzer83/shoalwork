import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AudioSpawn } from "../../src/audio/process.js"

// Fake `rec`/`play`: node scripts run in place of the sox binaries. Behavior is chosen by FAKE_* variables.
const REC = `
const mode = process.env.FAKE_MODE ?? "frames"
if (mode === "noisy") { process.stderr.write("x".repeat(5000) + "END-MARK", () => process.exit(1)) }
else if (mode === "fail") { process.stderr.write("rec FAIL formats: can't open input device\\n"); process.exit(2) }
const frameBytes = 1024
const make = (i) => { const b = Buffer.alloc(frameBytes); for (let s = 0; s < 512; s++) b.writeInt16LE(i + 1, s * 2); return b }
if (mode === "forever") {
  let i = 0
  setInterval(() => process.stdout.write(make(i++ % 100)), 5)
} else {
  const count = Number(process.env.FAKE_FRAMES ?? "3")
  const parts = []
  for (let i = 0; i < count; i++) parts.push(make(i))
  parts.push(Buffer.alloc(Number(process.env.FAKE_EXTRA_BYTES ?? "0")))
  const all = Buffer.concat(parts)
  // Uneven chunks, so frames straddle writes.
  let offset = 0
  const pump = () => {
    if (offset >= all.length) return process.exit(0)
    process.stdout.write(all.subarray(offset, offset + 700), () => { offset += 700; pump() })
  }
  pump()
}
`

const PLAY = `
const fs = require("node:fs")
const mode = process.env.FAKE_MODE ?? "record"
if (mode === "exit1") { process.stderr.write("play FAIL: no output device\\n"); process.exit(1) }
if (mode === "noisy") { process.stderr.write("x".repeat(5000) + "END-MARK", () => process.exit(1)) }
else if (mode === "stubborn") {
  process.on("SIGTERM", () => {})
  process.stdin.resume()
  setInterval(() => {}, 1000)
  process.stderr.write("ready\\n")
}
else if (mode === "early") { process.stdin.destroy(); process.exit(3) }
else if (mode === "idle") { process.stdin.resume(); setInterval(() => {}, 1000) }
else {
  const chunks = []
  process.stdin.on("data", (c) => chunks.push(c))
  process.stdin.on("end", () => { fs.writeFileSync(process.env.FAKE_OUT, Buffer.concat(chunks)); process.exit(0) })
}
`

export type Fakes = {
  readonly dir: string
  readonly rec: AudioSpawn
  readonly play: AudioSpawn
  readonly spawned: ChildProcess[]
  readonly calls: Array<{
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly options: SpawnOptions
  }>
  readonly cleanup: () => void
}

export const makeFakes = (): Fakes => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-audio-"))
  const recScript = join(dir, "rec.cjs")
  const playScript = join(dir, "play.cjs")
  writeFileSync(recScript, REC)
  writeFileSync(playScript, PLAY)
  const spawned: ChildProcess[] = []
  const calls: Fakes["calls"][number][] = []
  const via =
    (script: string): AudioSpawn =>
    (command, args, options) => {
      calls.push({ command, args, options })
      const child = spawn(process.execPath, [script, ...args], options)
      spawned.push(child)
      return child
    }
  return {
    dir,
    rec: via(recScript),
    play: via(playScript),
    spawned,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
