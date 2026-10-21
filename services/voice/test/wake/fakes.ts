import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import type { CaptureShape } from "../../src/audio/capture.js"
import type { Frame } from "../../src/audio/frame.js"
import type { AudioSpawn } from "../../src/audio/process.js"

// Stands in for wake_server.py: a node script that speaks the same stdin/stdout protocol.
// A 1280-sample frame whose first sample is 1234 is a "wake"; FAKE_MODE selects the failures.
const SIDECAR = `
const FRAME_BYTES = 2560
const MARKER = 1234
const mode = process.env.FAKE_MODE ?? "detect"
let pending = Buffer.alloc(0)
let index = 0
if (mode === "garbage") process.stdout.write("this is not json\\n")
else process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= FRAME_BYTES) {
    const frame = pending.subarray(0, FRAME_BYTES)
    pending = pending.subarray(FRAME_BYTES)
    if (mode === "crash") {
      process.stderr.write("model broke", () => process.exit(3))
      return
    }
    if (frame.readInt16LE(0) === MARKER)
      process.stdout.write(JSON.stringify({ wake: "hey_test", score: 0.93, t: index * 80 }) + "\\n")
    index += 1
  }
})
process.stdin.on("end", () => process.exit(0))
`

export type SidecarFake = {
  readonly dir: string
  readonly spawn: AudioSpawn
  readonly calls: Array<{
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly env: unknown
  }>
  readonly children: ChildProcess[]
  readonly cleanup: () => void
}

export const makeSidecarFake = (): SidecarFake => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-wake-"))
  const script = join(dir, "sidecar.cjs")
  writeFileSync(script, SIDECAR)
  const calls: SidecarFake["calls"][number][] = []
  const children: ChildProcess[] = []
  return {
    dir,
    calls,
    children,
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env })
      const child = spawn(process.execPath, [script, ...args], options)
      children.push(child)
      return child
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export const CAPTURE_FRAME_SAMPLES = 512

// Capture frames of 512 samples covering `totalSamples`, with the given sample offsets set to the wake marker.
export const framesWithMarkers = (totalSamples: number, markers: ReadonlyArray<number>): Frame[] => {
  const count = totalSamples / CAPTURE_FRAME_SAMPLES
  const frames: Frame[] = []
  for (let index = 0; index < count; index++) {
    frames.push({ pcm: new Int16Array(CAPTURE_FRAME_SAMPLES), t: index * 32 })
  }
  for (const offset of markers) {
    const frame = frames[Math.floor(offset / CAPTURE_FRAME_SAMPLES)]
    if (frame !== undefined) frame.pcm[offset % CAPTURE_FRAME_SAMPLES] = 1234
  }
  return frames
}

// A capture that yields `frames` and then, when `endless`, stays open like a live microphone.
export const fakeCapture = (frames: ReadonlyArray<Frame>, endless = false): CaptureShape => ({
  frames: () => {
    const finite = Stream.fromIterable(frames)
    return endless ? Stream.concat(finite, Stream.fromEffect(Effect.never)) : finite
  },
  device: () => Effect.succeed("fake"),
})
