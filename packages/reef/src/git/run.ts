import { spawn } from "node:child_process"
import { Data, Effect } from "effect"

export const GIT_TIMEOUT_MS = 10_000
// Output of one git call is cut here: a huge diff or blame must not reach the briefing whole.
export const GIT_OUTPUT_MAX_BYTES = 64 * 1024
const STDERR_MAX_BYTES = 512

export class GitIntelError extends Data.TaggedError("GitIntelError")<{
  readonly reason: "spawn" | "exit" | "timeout" | "invalid"
  readonly detail: string
}> {}

// A parent shell may export these; they would make `git -C <dir>` read some other repository.
const GIT_ENV_STRIPPED = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_ENV_STRIPPED.has(key))),
  GIT_TERMINAL_PROMPT: "0",
})

// Options every call carries: literal pathspecs (`[id].ts` is not a glob), no colour, no pager, no quoted unicode names.
const GLOBAL_ARGS = [
  "--literal-pathspecs",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=false",
  "--no-pager",
]

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Runs git with argv only (never a shell), bounded in time and in output. Output past GIT_OUTPUT_MAX_BYTES stops the
// process and returns what was read; a call that does not finish in GIT_TIMEOUT_MS is killed and fails.
export const runGit = (repoDir: string, args: ReadonlyArray<string>): Effect.Effect<string, GitIntelError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn("git", [...GLOBAL_ARGS, "-C", repoDir, ...args], {
          env: gitEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        })
        const chunks: Array<Buffer> = []
        let size = 0
        let truncated = false
        let timedOut = false
        let stderr = ""
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, GIT_TIMEOUT_MS)
        child.stdout.on("data", (chunk: Buffer) => {
          if (truncated) return
          const room = GIT_OUTPUT_MAX_BYTES - size
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room))
            size = GIT_OUTPUT_MAX_BYTES
            truncated = true
            child.kill("SIGKILL")
            return
          }
          chunks.push(chunk)
          size += chunk.length
        })
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString("utf8", 0, STDERR_MAX_BYTES)
        })
        child.on("error", (cause) => {
          clearTimeout(timer)
          reject(new GitIntelError({ reason: "spawn", detail: messageOf(cause) }))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          if (timedOut) {
            reject(
              new GitIntelError({
                reason: "timeout",
                detail: `git ${args[0] ?? ""} exceeded ${GIT_TIMEOUT_MS} ms`,
              }),
            )
          } else if (truncated || code === 0) {
            resolve(Buffer.concat(chunks).toString("utf8"))
          } else {
            reject(
              new GitIntelError({
                reason: "exit",
                detail: stderr.split("\n")[0] || `git exited with ${code}`,
              }),
            )
          }
        })
      }),
    catch: (cause) =>
      cause instanceof GitIntelError
        ? cause
        : new GitIntelError({ reason: "spawn", detail: messageOf(cause) }),
  })
