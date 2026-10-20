import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { redactUrls } from "./git.js"

// Runs `git <args>` in one worktree and reports the exit code without judging it. Callers bind it to a Tank context
// (`tank.exec(ctx, ["git", ...args])`) or to a local process; these helpers never choose the directory themselves.
export type GitExec = (args: ReadonlyArray<string>) => Effect.Effect<GitOutcome, TankError>

export type GitOutcome = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

export type GitIdentity = { readonly name: string; readonly email: string }

export type IntegrateResult =
  | { readonly _tag: "Clean" }
  // The operation was undone (rebase/merge aborted): the worktree is as it was before the call.
  | { readonly _tag: "Conflict"; readonly files: ReadonlyArray<string> }

const fail = (op: string, detail: string): TankError =>
  new TankError({ op, cause: redactUrls(detail.trim()) })

const safeRef = (name: string, value: string): Effect.Effect<void, TankError> =>
  value === "" || value.startsWith("-")
    ? Effect.fail(fail("git", `invalid ${name}: ${JSON.stringify(value)}`))
    : Effect.void

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

const mustRun = (exec: GitExec, op: string, args: ReadonlyArray<string>) =>
  exec(args).pipe(
    Effect.flatMap((r) => (r.exitCode === 0 ? Effect.succeed(r) : Effect.fail(fail(op, r.stderr)))),
  )

const unmergedFiles = (exec: GitExec) =>
  mustRun(exec, "git diff", ["diff", "--name-only", "--diff-filter=U"]).pipe(
    Effect.map((r) => lines(r.stdout)),
  )

// Files the branch changed relative to the merge base with origin/<base> (`git diff --name-only origin/<base>...<head>`).
export const changedFiles = (
  exec: GitExec,
  base: string,
  head = "HEAD",
): Effect.Effect<ReadonlyArray<string>, TankError> =>
  Effect.gen(function* () {
    yield* safeRef("base", base)
    yield* safeRef("head", head)
    const r = yield* mustRun(exec, "git diff", ["diff", "--name-only", `origin/${base}...${head}`, "--"])
    return lines(r.stdout)
  })

const identityArgs = (identity: GitIdentity): ReadonlyArray<string> => [
  "-c",
  `user.name=${identity.name}`,
  "-c",
  `user.email=${identity.email}`,
]

// Runs a rebase or merge that already failed through to its end: a conflict is aborted and named, and any other
// failure also tries the abort (its own failure is ignored) so no half-done operation is left in the worktree.
const settle = (
  exec: GitExec,
  op: "rebase" | "merge",
  failure: GitOutcome,
): Effect.Effect<IntegrateResult, TankError> =>
  Effect.gen(function* () {
    const abort = exec([op, "--abort"]).pipe(Effect.ignore)
    const files = yield* unmergedFiles(exec).pipe(
      Effect.catch((error) => abort.pipe(Effect.andThen(Effect.fail(error)))),
    )
    yield* abort
    if (files.length === 0) return yield* Effect.fail(fail(`git ${op}`, failure.stderr))
    return { _tag: "Conflict", files } as const
  })

// Fetches origin and rebases the current branch onto origin/<base>, committing as `identity` (a rebase writes
// commits, so it needs one). A conflict aborts the rebase and names the files; any other failure is a TankError.
export const fetchRebase = (
  exec: GitExec,
  base: string,
  identity: GitIdentity,
): Effect.Effect<IntegrateResult, TankError> =>
  Effect.gen(function* () {
    yield* safeRef("base", base)
    yield* mustRun(exec, "git fetch", ["fetch", "origin"])
    const rebase = yield* exec([...identityArgs(identity), "rebase", `origin/${base}`])
    if (rebase.exitCode === 0) return { _tag: "Clean" } as const
    return yield* settle(exec, "rebase", rebase)
  })

// `git merge --no-ff <ref>` in the current worktree, committed as `identity`. A conflict aborts the merge and names
// the files; any other failure is a TankError.
export const mergeNoFf = (
  exec: GitExec,
  ref: string,
  message: string,
  identity: GitIdentity,
): Effect.Effect<IntegrateResult, TankError> =>
  Effect.gen(function* () {
    yield* safeRef("ref", ref)
    const merge = yield* exec([...identityArgs(identity), "merge", "--no-ff", `--message=${message}`, ref])
    if (merge.exitCode === 0) return { _tag: "Clean" } as const
    return yield* settle(exec, "merge", merge)
  })
