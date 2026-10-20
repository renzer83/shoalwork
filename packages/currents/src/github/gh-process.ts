import { spawn } from "node:child_process"
import { Data, Effect } from "effect"

// Every gh call goes through this boundary. The real one spawns gh; tests substitute a scripted GhRun.
export class GhError extends Data.TaggedError("GhError")<{
  readonly op: string
  readonly message: string
}> {}

// Where a call runs: the Bot's env (HOME of the Bot, so its gh login is used) and the Bot's worktree.
export interface GhContext {
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export type GhEnv = Readonly<Record<string, string>>

// Host calls (no Bot) get only these keys; the core's full env (secrets) never reaches gh.
const HOST_ENV_KEYS: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "GH_CONFIG_DIR",
  "GH_HOST",
]

export const hostGhEnv = (baseEnv: Readonly<Record<string, string | undefined>>): GhEnv => {
  const env: Record<string, string> = {}
  for (const key of HOST_ENV_KEYS) {
    const value = baseEnv[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export interface GhOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type GhRun = (
  op: string,
  argv: ReadonlyArray<string>,
  env: GhEnv,
  cwd: string | undefined,
  timeoutMs: number,
) => Effect.Effect<GhOutput, GhError>

// After SIGTERM to the group, SIGKILL follows this long later unless the group has already closed.
export const KILL_GRACE_MS = 5_000
const OUTPUT_LIMIT = 1_000_000

const appendCapped = (acc: string, chunk: string): string =>
  acc.length >= OUTPUT_LIMIT ? acc : (acc + chunk).slice(0, OUTPUT_LIMIT)

// The real process: spawn("gh", args) with exactly the given env, in its own process group, so a timeout or an abort
// kills gh and everything it started. argv[0] is always "gh" (the builders in gh.ts guarantee it).
export const runGhProcess: GhRun = (op, argv, env, cwd, timeoutMs) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<GhOutput>((resolve, reject) => {
        const child = spawn("gh", argv.slice(1), {
          env: { ...env },
          ...(cwd === undefined ? {} : { cwd }),
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        const killTimers: Array<NodeJS.Timeout> = []
        const killGroup = (killSignal: NodeJS.Signals) => {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, killSignal)
          } catch (_cause) {
            // The group is already gone; the child's own kill covers a process that never got a group.
            child.kill(killSignal)
          }
        }
        const escalate = () => {
          killGroup("SIGTERM")
          const killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
          killTimer.unref()
          killTimers.push(killTimer)
        }
        const timer = setTimeout(() => {
          timedOut = true
          escalate()
        }, timeoutMs)
        const onAbort = () => escalate()
        signal.addEventListener("abort", onAbort, { once: true })
        const finish = () => {
          clearTimeout(timer)
          for (const killTimer of killTimers) clearTimeout(killTimer)
          signal.removeEventListener("abort", onAbort)
        }
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
          stdout = appendCapped(stdout, chunk)
        })
        child.stderr.on("data", (chunk: string) => {
          stderr = appendCapped(stderr, chunk)
        })
        child.on("error", (cause) => {
          finish()
          reject(cause)
        })
        child.on("close", (code) => {
          finish()
          resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
        })
      }),
    catch: () => new GhError({ op, message: `${op} could not run` }),
  })
