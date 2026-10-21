import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { constants } from "node:os"
import { createInterface } from "node:readline"
import { TankError } from "@shoalwork/contracts"
import { type Cause, Deferred, Effect, Option, Queue, type Scope, Stream } from "effect"
import type { ExecResult, RunningProcess } from "./tank.js"

export type ProcessOptions = {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type RunOptions = ProcessOptions & {
  readonly timeoutMs?: number
  readonly stdin?: string
  readonly maxOutputBytes?: number
}

// Grace period between SIGTERM and SIGKILL of the process group.
const KILL_GRACE_MS = 5000

type Closed = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

const exitCodeOf = ({ code, signal }: Closed): number =>
  code ?? (signal === null ? -1 : 128 + (constants.signals[signal] ?? 0))

// Signals the whole process group (children are spawned detached, so pgid == pid). Never throws.
// Returns whether the group may still exist: ESRCH means gone; any other error (EPERM) means "exists, unsignalable".
const signalGroup = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0): boolean => {
  try {
    process.kill(-pid, signal)
    return true
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH")
  }
}

const POLL_MS = 25

// The first `max` bytes of the text, never ending inside a multi-byte character.
const cutBytes = (text: string, max: number): string => {
  const buf = Buffer.from(text, "utf8")
  let end = Math.min(max, buf.length)
  // The byte after the cut is a continuation byte (10xxxxxx): the cut is inside a character, back up to its start.
  while (end > 0 && end < buf.length && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buf.toString("utf8", 0, end)
}

// Every process a Tank spawns while it runs, keyed by pid. The watchdog reads it to find processes that run too long.
export type TrackedProcess = {
  readonly pid: number
  readonly startedAt: number
  // The directory the process was started in: the Lead matches a run to its processes by it.
  readonly cwd: string
  // Same as the owner's terminate: SIGTERM to the group, SIGKILL after the grace period.
  readonly terminate: Effect.Effect<void>
}

const tracked = new Map<number, TrackedProcess>()

export const trackedProcesses = (): ReadonlyArray<TrackedProcess> => Array.from(tracked.values())

type Spawned = {
  readonly child: ChildProcessWithoutNullStreams
  readonly pid: number
  readonly closed: Deferred.Deferred<Closed>
  // SIGTERM to the group, SIGKILL after the grace period; resolves once the leader has closed and the group is
  // empty (or the grace after SIGKILL ran out). Safe to call after the leader closed: orphans are still reaped.
  readonly terminate: Effect.Effect<void>
  readonly signal: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>
}

// `attach` runs synchronously right after spawn, before any output can be emitted.
const spawnRaw = (
  cmd: ReadonlyArray<string>,
  opts: ProcessOptions,
  attach: (child: ChildProcessWithoutNullStreams) => void,
): Effect.Effect<Spawned, TankError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Spawned, TankError>((resume) => {
      const [file, ...args] = cmd
      if (file === undefined || file === "") {
        resume(Effect.fail(new TankError({ op: "spawn", cause: "empty command" })))
        return
      }
      const failSpawn = (cause: unknown) => resume(Effect.fail(new TankError({ op: "spawn", cause })))
      let child: ChildProcessWithoutNullStreams
      try {
        // Never a shell: argv goes straight to execve.
        child = spawn(file, args, {
          cwd: opts.cwd,
          env: { ...opts.env },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch (cause) {
        failSpawn(cause)
        return
      }
      const closed = Deferred.makeUnsafe<Closed>()
      let done = false
      child.stdin.on("error", () => {}) // EPIPE when the child exits before reading
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.once("error", failSpawn)
      child.once("close", (code, signal) => {
        done = true
        Deferred.doneUnsafe(closed, Effect.succeed({ code, signal }))
      })
      child.once("spawn", () => {
        child.removeListener("error", failSpawn)
        child.on("error", () => {}) // later errors (kill failures) are not actionable
        const pid = child.pid
        if (pid === undefined) return failSpawn("no pid")
        attach(child)
        const signal = (s: "SIGTERM" | "SIGKILL") =>
          Effect.sync(() => {
            if (!done) signalGroup(pid, s)
          })
        const settled = () => done && !signalGroup(pid, 0)
        const waitSettled = (ms: number) =>
          Effect.gen(function* () {
            const deadline = Date.now() + ms
            while (!settled()) {
              if (Date.now() >= deadline) return false
              yield* Effect.sleep(POLL_MS)
            }
            return true
          })
        const terminate = Effect.gen(function* () {
          // Always signal the group, even when the leader already closed: background children may outlive it.
          signalGroup(pid, "SIGTERM")
          if (yield* waitSettled(KILL_GRACE_MS)) return
          signalGroup(pid, "SIGKILL")
          yield* waitSettled(KILL_GRACE_MS)
        })
        tracked.set(pid, { pid, startedAt: Date.now(), cwd: opts.cwd, terminate })
        resume(Effect.succeed({ child, pid, closed, terminate, signal }))
      })
    }),
    (p) =>
      Effect.sync(() => {
        tracked.delete(p.pid)
      }).pipe(Effect.andThen(p.terminate)),
  )

export const spawnProcess = (
  cmd: ReadonlyArray<string>,
  opts: ProcessOptions,
): Effect.Effect<RunningProcess, TankError, Scope.Scope> =>
  Effect.gen(function* () {
    // Queues are created before the child so that lines emitted at spawn time are never lost.
    const outQueue = yield* Queue.unbounded<string, Cause.Done>()
    const errQueue = yield* Queue.unbounded<string, Cause.Done>()
    const feed = (queue: Queue.Queue<string, Cause.Done>, readable: NodeJS.ReadableStream) => {
      const rl = createInterface({ input: readable, crlfDelay: Infinity })
      rl.on("line", (line) => {
        Queue.offerUnsafe(queue, line)
      })
      rl.on("close", () => {
        Queue.endUnsafe(queue)
      })
    }
    const p = yield* spawnRaw(cmd, opts, (child) => {
      feed(outQueue, child.stdout)
      feed(errQueue, child.stderr)
    })
    return {
      pid: p.pid,
      stdout: Stream.fromQueue(outQueue),
      stderr: Stream.fromQueue(errQueue),
      exitCode: Deferred.await(p.closed).pipe(Effect.map(exitCodeOf)),
      writeStdin: (s) =>
        Effect.sync(() => {
          if (!p.child.stdin.destroyed) p.child.stdin.write(s)
        }),
      closeStdin: () =>
        Effect.sync(() => {
          if (!p.child.stdin.destroyed) p.child.stdin.end()
        }),
      kill: (signal = "SIGTERM") => p.signal(signal),
    }
  })

// Runs to completion, collecting raw stdout/stderr. Interruption kills the process group (scope finalizer).
// With maxOutputBytes the output stops growing at the cap and the group is killed (outputTruncated).
export const runProcess = (
  cmd: ReadonlyArray<string>,
  opts: RunOptions,
): Effect.Effect<ExecResult, TankError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Date.now()
      let stdout = ""
      let stderr = ""
      let bytes = 0
      let truncated = false
      const cap = opts.maxOutputBytes
      const overflow = Deferred.makeUnsafe<void>()
      // Appends what fits under the cap; the first excess chunk flags the overflow and later chunks are dropped.
      const take = (chunk: string, into: "out" | "err") => {
        let text = chunk
        if (cap !== undefined) {
          if (truncated) return
          const size = Buffer.byteLength(chunk)
          if (bytes + size > cap) {
            text = cutBytes(chunk, Math.max(0, cap - bytes))
            truncated = true
            Deferred.doneUnsafe(overflow, Effect.void)
          }
          bytes = Math.min(cap, bytes + size)
        }
        if (into === "out") stdout += text
        else stderr += text
      }
      const p = yield* spawnRaw(cmd, opts, (child) => {
        child.stdout.on("data", (chunk: string) => take(chunk, "out"))
        child.stderr.on("data", (chunk: string) => take(chunk, "err"))
      })
      // Always close stdin so commands that read it do not hang.
      p.child.stdin.end(opts.stdin ?? "")
      // None = the output cap fired (or the timeout, below); Some = the leader closed.
      const waited = Effect.raceFirst(
        Deferred.await(p.closed).pipe(Effect.map(Option.some)),
        Deferred.await(overflow).pipe(Effect.as(Option.none<Closed>())),
      )
      const result =
        opts.timeoutMs === undefined
          ? yield* waited
          : Option.flatten(yield* waited.pipe(Effect.timeoutOption(opts.timeoutMs)))
      const timedOut = Option.isNone(result) && !truncated
      if (Option.isNone(result)) yield* p.terminate
      // After terminate the leader is closed unless even SIGKILL failed; never hang on it.
      const closed = Option.isSome(result)
        ? Option.some(result.value)
        : yield* Deferred.await(p.closed).pipe(Effect.timeoutOption(1000))
      return {
        exitCode: Option.isSome(closed) ? exitCodeOf(closed.value) : -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        ...(truncated ? { outputTruncated: true } : {}),
      }
    }),
  )
