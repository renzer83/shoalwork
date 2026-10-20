import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { ensureClone, worktreeAdd } from "../src/git.js"
import { changedFiles, fetchRebase, type GitExec, mergeNoFf } from "../src/git-integrate.js"
import { TankLocalLive } from "../src/local.js"
import { localOps } from "../src/ops.js"
import { Tank } from "../src/tank.js"
import { gitEnv, makeBot, makeOrigin, stepId, tempDir } from "./helpers.js"

const env = gitEnv()
const root = tempDir()
const { origin, pushCommit } = makeOrigin(root)
const repoDir = join(root, "clone")
const ID = { name: "lead", email: "lead@bots.shoalwork.invalid" }

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" })

// No identity anywhere but the command line: no global/system git config, a throwaway HOME, no GIT_AUTHOR/COMMITTER.
const isolatedHome = join(root, "home")
mkdirSync(isolatedHome, { recursive: true })
const noIdentity = {
  ...Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("GIT_AUTHOR") && !key.startsWith("GIT_COMMITTER")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: isolatedHome,
}

const execIn =
  (cwd: string): GitExec =>
  (args) =>
    localOps.run(["git", ...args], { cwd, env: noIdentity, timeoutMs: 60_000 })

const commitFile = (cwd: string, file: string, content: string) => {
  writeFileSync(join(cwd, file), content)
  git(cwd, "add", file)
  git(cwd, "commit", "-m", `edit ${file}`)
}

describe("git integration helpers", () => {
  it.live("changedFiles lists what a branch changed against origin/<base>", () =>
    Effect.gen(function* () {
      yield* ensureClone(repoDir, origin, "main", env)
      const wt = join(root, "wt-a")
      yield* worktreeAdd(repoDir, wt, "bot/a/s1", "main", env)
      commitFile(wt, "a.txt", "a\n")
      commitFile(wt, "shared.txt", "from a\n")
      expect([...(yield* changedFiles(execIn(wt), "main"))].sort()).toEqual(["a.txt", "shared.txt"])
      const e = yield* changedFiles(execIn(wt), "--evil").pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      // Revisions end with `--`, so a branch that is also a file name is never read as a path.
      const seen: Array<ReadonlyArray<string>> = []
      yield* changedFiles((args) => {
        seen.push(args)
        return execIn(wt)(args)
      }, "main")
      expect(seen[0]?.at(-1)).toBe("--")
    }),
  )

  it.live("fetchRebase rebases onto a moved base and reports a conflict after aborting", () =>
    Effect.gen(function* () {
      const clean = join(root, "wt-clean")
      yield* worktreeAdd(repoDir, clean, "bot/b/clean", "main", env)
      commitFile(clean, "b.txt", "b\n")
      pushCommit("moved.txt")
      expect(yield* fetchRebase(execIn(clean), "main", ID)).toEqual({ _tag: "Clean" })
      // The rebase rewrote the commit, and the only identity it could use is the one passed on the command line.
      expect(git(clean, "log", "--format=%cn|%ce", "-1").trim()).toBe("lead|lead@bots.shoalwork.invalid")
      expect(git(clean, "log", "--format=%s", "-3")).toContain("add moved.txt")

      const clash = join(root, "wt-clash")
      yield* worktreeAdd(repoDir, clash, "bot/b/clash", "main", env)
      commitFile(clash, "README.txt", "mine\n")
      // The base now changes the same file differently.
      writeFileSync(join(root, "seed", "README.txt"), "theirs\n")
      git(join(root, "seed"), "commit", "-am", "edit readme")
      git(join(root, "seed"), "push", "origin", "main")
      const result = yield* fetchRebase(execIn(clash), "main", ID)
      expect(result).toEqual({ _tag: "Conflict", files: ["README.txt"] })
      // Aborted: no rebase in progress and the branch still has its own commit.
      expect(git(clash, "status", "--porcelain")).toBe("")
      expect(git(clash, "log", "--format=%s", "-1")).toContain("edit README.txt")
    }),
  )

  it.live("mergeNoFf merges with a merge commit and aborts a conflicting merge", () =>
    Effect.gen(function* () {
      const integ = join(root, "wt-integ")
      yield* worktreeAdd(repoDir, integ, "bot/lead/integ", "main", env)
      const one = join(root, "wt-one")
      const two = join(root, "wt-two")
      yield* worktreeAdd(repoDir, one, "bot/c/one", "main", env)
      yield* worktreeAdd(repoDir, two, "bot/c/two", "main", env)
      commitFile(one, "same.txt", "one\n")
      commitFile(two, "same.txt", "two\n")
      expect(yield* mergeNoFf(execIn(integ), "bot/c/one", "merge one", ID)).toEqual({ _tag: "Clean" })
      expect(git(integ, "log", "--format=%an|%s", "-1")).toBe("lead|merge one\n")
      expect(git(integ, "rev-list", "--merges", "--count", "HEAD").trim()).toBe("1")
      const result = yield* mergeNoFf(execIn(integ), "bot/c/two", "merge two", ID)
      expect(result).toEqual({ _tag: "Conflict", files: ["same.txt"] })
      expect(git(integ, "status", "--porcelain")).toBe("")
      const e = yield* mergeNoFf(execIn(integ), "bot/nope", "x", ID).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
    }),
  )
  it.live("a failure that is not a conflict still tries the abort and leaves the worktree clean", () =>
    Effect.gen(function* () {
      const wt = join(root, "wt-plain")
      yield* worktreeAdd(repoDir, wt, "bot/d/plain", "main", env)
      const seen: Array<string> = []
      const spy: GitExec = (args) => {
        seen.push(args.join(" "))
        return execIn(wt)(args)
      }
      const e = yield* mergeNoFf(spy, "bot/missing-branch", "x", ID).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      expect(seen.some((line) => line === "merge --abort")).toBe(true)
      expect(git(wt, "status", "--porcelain")).toBe("")
      const noBase = yield* fetchRebase(spy, "no-such-base", ID).pipe(Effect.flip)
      expect(noBase).toBeInstanceOf(TankError)
      expect(seen.some((line) => line === "rebase --abort")).toBe(true)
      expect(git(wt, "status", "--porcelain")).toBe("")
    }),
  )
})

describe("fetch and rebase under the clone lock of the Tank", () => {
  const tankRoot = join(root, "tanks")
  const layer = TankLocalLive({ root: tankRoot, baseEnv: { ...env } })

  it.live("three steps of one Bot fetch and rebase at once without a lock error", () =>
    Effect.gen(function* () {
      const tank = yield* Tank
      const bot = makeBot("locker")
      const repo = { url: origin, base: "main" }
      const ctxs = yield* Effect.forEach([0, 1, 2], () => tank.prepare(bot, { stepId: stepId(), repo }))
      const results = yield* Effect.forEach(
        ctxs,
        (ctx) =>
          fetchRebase(
            (args) =>
              tank
                .exec(ctx, ["git", ...args], { lockRepo: true })
                .pipe(Effect.map((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }))),
            "main",
            ID,
          ),
        { concurrency: "unbounded" },
      )
      expect(results).toEqual([{ _tag: "Clean" }, { _tag: "Clean" }, { _tag: "Clean" }])
      yield* Effect.forEach(ctxs, (ctx) => tank.release(ctx, { keepWorktree: false }))
    }).pipe(Effect.provide(layer)),
  )
})
