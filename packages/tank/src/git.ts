import { mkdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { TankError, WorktreeConflict } from "@shoalwork/contracts"
import { Effect } from "effect"
import { runProcess } from "./process.js"

export type GitEnv = Readonly<Record<string, string>>

export type WorktreeInfo = {
  readonly path: string
  readonly head: string
  readonly branch?: string
}

// Local paths and ssh/http(s)/git only; blocks exotic transports (ext::, etc.) for URLs that come from tasks.
const gitEnv = (env: GitEnv): Record<string, string> => ({
  ...env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
})

// Credentials embedded in URLs (https://user:token@host) must never reach an error cause.
export const redactUrls = (text: string): string => text.replace(/:\/\/[^@/\s]+@/g, "://***@")

const describeCause = (cause: unknown): string =>
  redactUrls(cause instanceof Error ? cause.message : String(cause))

const gitError = (op: string, cause: unknown): TankError => new TankError({ op, cause: describeCause(cause) })

type GitOutput = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

// Runs `git <args>` and returns the result without judging the exit code.
const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: GitEnv,
  timeoutMs = 300_000,
): Effect.Effect<GitOutput, TankError> =>
  runProcess(["git", ...args], { cwd, env: gitEnv(env), timeoutMs }).pipe(
    Effect.mapError((e) => gitError(e.op, e.cause)),
    Effect.flatMap((r) =>
      r.timedOut
        ? Effect.fail(gitError(`git ${args[0] ?? ""}`, "timed out"))
        : Effect.succeed({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }),
    ),
  )

// Runs `git <args>` and fails with TankError (stderr as cause) on a non-zero exit.
const git = (cwd: string, args: ReadonlyArray<string>, env: GitEnv): Effect.Effect<string, TankError> =>
  runGit(cwd, args, env).pipe(
    Effect.flatMap((r) =>
      r.exitCode === 0
        ? Effect.succeed(r.stdout)
        : Effect.fail(gitError(`git ${args[0] ?? ""}`, r.stderr.trim())),
    ),
  )

const exists = (path: string): Effect.Effect<boolean, TankError> =>
  Effect.tryPromise({
    try: () =>
      stat(path).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
          throw cause
        },
      ),
    catch: (cause) => new TankError({ op: "stat", cause }),
  })

const ensureSafeRef = (name: string, value: string): Effect.Effect<void, TankError> =>
  value === "" || value.startsWith("-")
    ? Effect.fail(gitError("git", `invalid ${name}: ${JSON.stringify(value)}`))
    : Effect.void

// Clones `url` into `repoDir` when missing (no checkout: only worktrees are used), then always fetches.
export const ensureClone = (
  repoDir: string,
  url: string,
  base: string,
  env: GitEnv,
): Effect.Effect<void, TankError> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("base", base)
    yield* ensureSafeRef("url", url)
    if (!(yield* exists(join(repoDir, ".git")))) {
      const parent = dirname(repoDir)
      yield* Effect.tryPromise({
        try: () => mkdir(parent, { recursive: true }),
        catch: (cause) => new TankError({ op: "mkdir", cause }),
      })
      yield* git(parent, ["clone", "--no-checkout", "--branch", base, "--", url, repoDir], env)
    }
    yield* git(repoDir, ["fetch", "origin"], env)
  })

const branchExists = (repoDir: string, branch: string, env: GitEnv): Effect.Effect<boolean, TankError> =>
  runGit(repoDir, ["show-ref", "--verify", "--quiet", "--", `refs/heads/${branch}`], env).pipe(
    Effect.flatMap((r) =>
      r.exitCode === 0
        ? Effect.succeed(true)
        : r.exitCode === 1
          ? Effect.succeed(false)
          : Effect.fail(gitError("git show-ref", r.stderr.trim())),
    ),
  )

// New branch `branch` off origin/<base>. An existing branch (or path) is a WorktreeConflict, never reused.
export const worktreeAdd = (
  repoDir: string,
  path: string,
  branch: string,
  base: string,
  env: GitEnv,
): Effect.Effect<void, TankError | WorktreeConflict> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("base", base)
    yield* ensureSafeRef("branch", branch)
    yield* ensureSafeRef("path", path)
    // Checked up front: from here on, a branch that exists afterwards may belong to someone else.
    if (yield* branchExists(repoDir, branch, env)) {
      return yield* Effect.fail(new WorktreeConflict({ branch, path }))
    }
    if (yield* exists(path)) return yield* Effect.fail(new WorktreeConflict({ branch, path }))
    const r = yield* runGit(
      repoDir,
      ["worktree", "add", "--no-track", "-b", branch, "--", path, `origin/${base}`],
      env,
    )
    if (r.exitCode === 0) return
    if (/already (exists|used by worktree|checked out)/.test(r.stderr)) {
      // Lost a race with another creator: the branch is theirs, leave it alone.
      return yield* Effect.fail(new WorktreeConflict({ branch, path }))
    }
    // The branch did not exist before this call; drop whatever git may have left behind.
    yield* runGit(repoDir, ["branch", "-D", "--", branch], env)
    return yield* Effect.fail(gitError("git worktree add", r.stderr.trim()))
  })

// Idempotent: a worktree/branch that is already gone is not an error.
export const worktreeRemove = (
  repoDir: string,
  path: string,
  branch: string,
  env: GitEnv,
): Effect.Effect<void, TankError> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("branch", branch)
    yield* ensureSafeRef("path", path)
    const removed = yield* runGit(repoDir, ["worktree", "remove", "--force", "--", path], env)
    if (removed.exitCode !== 0 && (yield* exists(path))) {
      return yield* Effect.fail(gitError("git worktree remove", removed.stderr.trim()))
    }
    yield* git(repoDir, ["worktree", "prune"], env)
    if (yield* branchExists(repoDir, branch, env)) {
      yield* git(repoDir, ["branch", "-D", "--", branch], env)
    }
  })

// Linked worktrees only: the main worktree of `repoDir` is not listed.
export const worktreeList = (
  repoDir: string,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<WorktreeInfo>, TankError> =>
  git(repoDir, ["worktree", "list", "--porcelain"], env).pipe(
    Effect.map((out) => parseWorktreeList(out).slice(1)),
  )

export const parseWorktreeList = (porcelain: string): ReadonlyArray<WorktreeInfo> =>
  porcelain
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .flatMap((block): Array<WorktreeInfo> => {
      let path: string | undefined
      let head = ""
      let branch: string | undefined
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length)
        else if (line.startsWith("branch "))
          branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
      }
      return path === undefined ? [] : [branch === undefined ? { path, head } : { path, head, branch }]
    })
