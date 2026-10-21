import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { VoiceError } from "@shoalwork/contracts"
import { Effect, type Scope } from "effect"

// `rec` and `play` (sox) are spawned by argv, never through a shell. The seam lets tests run fake binaries.
export type AudioSpawn = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess

export const defaultAudioSpawn: AudioSpawn = (command, args, options) => spawn(command, [...args], options)

export type ExitInfo = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  // Set when the process never started (for example ENOENT).
  readonly spawnError?: string | undefined
}

export type AudioProcess = {
  readonly child: ChildProcess
  readonly exit: Promise<ExitInfo>
  // True once `terminate` sent a signal: the exit that follows is ours, not a failure.
  readonly terminated: () => boolean
  readonly stderrTail: () => string
  // SIGTERM to the whole group right away; SIGKILL if it is still alive after the grace period.
  readonly terminate: Effect.Effect<void>
}

// Short on purpose: barge-in (T-108) cannot wait for a player that ignores SIGTERM.
export const KILL_GRACE_MS = 500
const STDERR_LIMIT = 2_000

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (cause) {
    // ESRCH: the group is already gone, which is the goal.
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
  }
}

const start = (
  op: "capture" | "playback",
  spawnProcess: AudioSpawn,
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): Effect.Effect<AudioProcess, VoiceError> =>
  Effect.try({
    try: (): AudioProcess => {
      const child = spawnProcess(command, args, { ...options, detached: true })
      let settled = false
      let exited = false
      let sent = false
      let stderr = ""
      const exit = new Promise<ExitInfo>((resolve) => {
        const finish = (info: ExitInfo) => {
          if (settled) return
          settled = true
          exited = true
          resolve(info)
        }
        child.on("error", (cause: NodeJS.ErrnoException) =>
          finish({ code: null, signal: null, spawnError: cause.code ?? "spawn failed" }),
        )
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal }))
      })
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (text: string) => {
        stderr = (stderr + text).slice(-STDERR_LIMIT)
      })
      const terminate = Effect.gen(function* () {
        const pid = child.pid
        if (exited || pid === undefined) return
        sent = true
        signalGroup(pid, "SIGTERM")
        yield* Effect.promise(() => exit).pipe(
          Effect.timeoutOrElse({
            duration: KILL_GRACE_MS,
            orElse: () =>
              Effect.sync(() => signalGroup(pid, "SIGKILL")).pipe(Effect.andThen(Effect.promise(() => exit))),
          }),
          Effect.asVoid,
        )
      })
      return { child, exit, terminated: () => sent, stderrTail: () => stderr.trim(), terminate }
    },
    catch: (cause) => new VoiceError({ op, reason: `${command} spawn failed: ${String(cause)}` }),
  })

// The child lives as long as the surrounding scope: closing it kills the process group.
export const spawnAudioProcess = (
  op: "capture" | "playback",
  spawnProcess: AudioSpawn,
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
): Effect.Effect<AudioProcess, VoiceError, Scope.Scope> =>
  Effect.acquireRelease(start(op, spawnProcess, command, args, options), (proc) => proc.terminate)

export const missingBinary = (command: string): string =>
  `${command} not found: install sox (brew install sox)`
