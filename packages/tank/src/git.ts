import { dirname, join } from "node:path"
import { TankError, WorktreeConflict } from "@shoalwork/contracts"
import { Effect } from "effect"
import { type BotOps, localOps } from "./ops.js"

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
  ops: BotOps,
  cwd: string,
  args: ReadonlyArray<string>,
  env: GitEnv,
  timeoutMs = 300_000,
): Effect.Effect<GitOutput, TankError> =>
  ops.run(["git", ...args], { cwd, env: gitEnv(env), timeoutMs }).pipe(
    Effect.mapError((e) => gitError(e.op, e.cause)),
    Effect.flatMap((r) =>
      r.timedOut
        ? Effect.fail(gitError(`git ${args[0] ?? ""}`, "timed out"))
        : Effect.succeed({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }),
    ),
  )

// Runs `git <args>` and fails with TankError (stderr as cause) on a non-zero exit.
const git = (
  ops: BotOps,
  cwd: string,
  args: ReadonlyArray<string>,
  env: GitEnv,
): Effect.Effect<string, TankError> =>
  runGit(ops, cwd, args, env).pipe(
    Effect.flatMap((r) =>
      r.exitCode === 0
        ? Effect.succeed(r.stdout)
        : Effect.fail(gitError(`git ${args[0] ?? ""}`, r.stderr.trim())),
    ),
  )

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
  ops: BotOps = localOps,
): Effect.Effect<void, TankError> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("base", base)
    yield* ensureSafeRef("url", url)
    if (!(yield* ops.exists(join(repoDir, ".git")))) {
      const parent = dirname(repoDir)
      yield* ops.mkdirp(parent)
      yield* git(ops, parent, ["clone", "--no-checkout", "--branch", base, "--", url, repoDir], env)
    }
    yield* git(ops, repoDir, ["fetch", "origin"], env)
  })

const branchExists = (
  ops: BotOps,
  repoDir: string,
  branch: string,
  env: GitEnv,
): Effect.Effect<boolean, TankError> =>
  runGit(ops, repoDir, ["show-ref", "--verify", "--quiet", "--", `refs/heads/${branch}`], env).pipe(
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
  ops: BotOps = localOps,
): Effect.Effect<void, TankError | WorktreeConflict> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("base", base)
    yield* ensureSafeRef("branch", branch)
    yield* ensureSafeRef("path", path)
    // Checked up front: from here on, a branch that exists afterwards may belong to someone else.
    if (yield* branchExists(ops, repoDir, branch, env)) {
      return yield* Effect.fail(new WorktreeConflict({ branch, path }))
    }
    if (yield* ops.exists(path)) return yield* Effect.fail(new WorktreeConflict({ branch, path }))
    const r = yield* runGit(
      ops,
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
    yield* runGit(ops, repoDir, ["branch", "-D", "--", branch], env)
    return yield* Effect.fail(gitError("git worktree add", r.stderr.trim()))
  })

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`)

// Real path as the Tank's own user resolves it; a path that does not resolve is refused.
const realPathOf = (
  ops: BotOps,
  repoDir: string,
  env: GitEnv,
  path: string,
): Effect.Effect<string, TankError> =>
  ops
    .run(["realpath", "--", path], { cwd: repoDir, env: gitEnv(env) })
    .pipe(
      Effect.flatMap((r) =>
        r.exitCode === 0
          ? Effect.succeed(r.stdout.trim())
          : Effect.fail(gitError("git worktree reuse", `cannot resolve ${JSON.stringify(path)}`)),
      ),
    )

// Continues a worktree kept by an earlier attempt. It is reused only when the branch is registered in repoDir at this
// very path, the path is not a symlink and resolves inside workDir. Nothing is created or reset.
export const worktreeReuse = (
  repoDir: string,
  path: string,
  branch: string,
  workDir: string,
  env: GitEnv,
  ops: BotOps = localOps,
): Effect.Effect<void, TankError> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("branch", branch)
    yield* ensureSafeRef("path", path)
    const link = yield* ops.run(["test", "-L", path], { cwd: repoDir, env: gitEnv(env) })
    if (link.exitCode === 0) {
      return yield* Effect.fail(gitError("git worktree reuse", "kept worktree path is a symlink"))
    }
    const realPath = yield* realPathOf(ops, repoDir, env, path)
    const realWork = yield* realPathOf(ops, repoDir, env, workDir)
    if (realPath === realWork || !within(realWork, realPath)) {
      return yield* Effect.fail(
        gitError("git worktree reuse", "kept worktree path escapes the work directory"),
      )
    }
    const registered = (yield* worktreeList(repoDir, env, ops)).filter(
      (worktree) => worktree.branch === branch,
    )
    const same = yield* Effect.forEach(registered, (worktree) =>
      realPathOf(ops, repoDir, env, worktree.path).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.map((resolved) => resolved === realPath),
      ),
    )
    if (!same.some(Boolean)) {
      return yield* Effect.fail(gitError("git worktree reuse", `no kept worktree for ${branch} at this path`))
    }
  })

// Idempotent: a worktree/branch that is already gone is not an error.
export const worktreeRemove = (
  repoDir: string,
  path: string,
  branch: string,
  env: GitEnv,
  ops: BotOps = localOps,
): Effect.Effect<void, TankError> =>
  Effect.gen(function* () {
    yield* ensureSafeRef("branch", branch)
    yield* ensureSafeRef("path", path)
    const removed = yield* runGit(ops, repoDir, ["worktree", "remove", "--force", "--", path], env)
    if (removed.exitCode !== 0 && (yield* ops.exists(path))) {
      return yield* Effect.fail(gitError("git worktree remove", removed.stderr.trim()))
    }
    yield* git(ops, repoDir, ["worktree", "prune"], env)
    if (yield* branchExists(ops, repoDir, branch, env)) {
      yield* git(ops, repoDir, ["branch", "-D", "--", branch], env)
    }
  })

// Linked worktrees only: the main worktree of `repoDir` is not listed.
export const worktreeList = (
  repoDir: string,
  env: GitEnv,
  ops: BotOps = localOps,
): Effect.Effect<ReadonlyArray<WorktreeInfo>, TankError> =>
  git(ops, repoDir, ["worktree", "list", "--porcelain"], env).pipe(
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
