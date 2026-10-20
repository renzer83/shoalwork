import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError, WorktreeConflict } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  ensureClone,
  parseWorktreeList,
  redactUrls,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "../src/git.js"
import { gitEnv, makeOrigin, tempDir } from "./helpers.js"

const env = gitEnv()
const root = tempDir()
const { origin, pushCommit } = makeOrigin(root)
const repoDir = join(root, "clone")

describe("git helpers", () => {
  it.live("ensureClone clones once and fetches new commits on later calls", () =>
    Effect.gen(function* () {
      yield* ensureClone(repoDir, origin, "main", env)
      expect(existsSync(join(repoDir, ".git"))).toBe(true)
      pushCommit("second.txt")
      yield* ensureClone(repoDir, origin, "main", env)
      const log = execFileSync("git", ["log", "--format=%s", "origin/main"], {
        cwd: repoDir,
        encoding: "utf8",
      })
      expect(log).toContain("add second.txt")
    }),
  )

  it.live("ensureClone fails with TankError for an unreachable url", () =>
    Effect.gen(function* () {
      const e = yield* ensureClone(join(root, "nope"), join(root, "missing.git"), "main", env).pipe(
        Effect.flip,
      )
      expect(e).toBeInstanceOf(TankError)
    }),
  )

  it.live("ensureClone rejects refs that look like options", () =>
    Effect.gen(function* () {
      const e = yield* ensureClone(join(root, "opt"), origin, "--upload-pack=x", env).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
    }),
  )

  it.live("worktreeAdd creates the branch off origin/base; a second add of the same branch conflicts", () =>
    Effect.gen(function* () {
      const path = join(root, "wt1")
      yield* worktreeAdd(repoDir, path, "bot/alice/step1", "main", env)
      expect(existsSync(join(path, "README.txt"))).toBe(true)
      const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, encoding: "utf8" })
      expect(head.trim()).toBe("bot/alice/step1")
      const listed = yield* worktreeList(repoDir, env)
      expect(listed.map((w) => w.branch)).toEqual(["bot/alice/step1"])

      const e = yield* worktreeAdd(repoDir, join(root, "wt1b"), "bot/alice/step1", "main", env).pipe(
        Effect.flip,
      )
      expect(e).toBeInstanceOf(WorktreeConflict)
      expect(e).toMatchObject({ branch: "bot/alice/step1" })
    }),
  )

  it.live("worktreeAdd conflicts when the target path already exists", () =>
    Effect.gen(function* () {
      const path = join(root, "wt1")
      const e = yield* worktreeAdd(repoDir, path, "bot/alice/other", "main", env).pipe(Effect.flip)
      expect(e).toBeInstanceOf(WorktreeConflict)
    }),
  )

  it.live("worktreeRemove deletes worktree and branch, and is idempotent", () =>
    Effect.gen(function* () {
      const path = join(root, "wt1")
      yield* worktreeRemove(repoDir, path, "bot/alice/step1", env)
      expect(existsSync(path)).toBe(false)
      expect(yield* worktreeList(repoDir, env)).toEqual([])
      const branches = execFileSync("git", ["branch", "--list", "bot/*"], { cwd: repoDir, encoding: "utf8" })
      expect(branches.trim()).toBe("")
      yield* worktreeRemove(repoDir, path, "bot/alice/step1", env)
    }),
  )

  it("parseWorktreeList reads porcelain blocks including detached heads", () => {
    const out = [
      "worktree /r",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /w",
      "HEAD bbb",
      "detached",
      "",
    ].join("\n")
    expect(parseWorktreeList(out)).toEqual([
      { path: "/r", head: "aaa", branch: "main" },
      { path: "/w", head: "bbb" },
    ])
  })

  it.live("a conflicting worktreeAdd leaves the pre-existing branch untouched", () =>
    Effect.gen(function* () {
      execFileSync("git", ["branch", "bot/alice/theirs", "origin/main"], { cwd: repoDir })
      const e = yield* worktreeAdd(repoDir, join(root, "wt-theirs"), "bot/alice/theirs", "main", env).pipe(
        Effect.flip,
      )
      expect(e).toBeInstanceOf(WorktreeConflict)
      const branches = execFileSync("git", ["branch", "--list", "bot/alice/theirs"], {
        cwd: repoDir,
        encoding: "utf8",
      })
      expect(branches).toContain("bot/alice/theirs")
      expect(existsSync(join(root, "wt-theirs"))).toBe(false)
    }),
  )

  it.live("worktreeAdd with a missing base fails with TankError and leaves no branch", () =>
    Effect.gen(function* () {
      const path = join(root, "wt-nobase")
      const e = yield* worktreeAdd(repoDir, path, "bot/alice/nobase", "no-such-branch", env).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      const branches = execFileSync("git", ["branch", "--list", "bot/alice/nobase"], {
        cwd: repoDir,
        encoding: "utf8",
      })
      expect(branches.trim()).toBe("")
      expect(existsSync(path)).toBe(false)
    }),
  )

  it.live("worktreeAdd and worktreeRemove reject option-like branch and path", () =>
    Effect.gen(function* () {
      const a = yield* worktreeAdd(repoDir, join(root, "x"), "--detach", "main", env).pipe(Effect.flip)
      expect(a).toBeInstanceOf(TankError)
      const b = yield* worktreeAdd(repoDir, "--force", "bot/alice/p", "main", env).pipe(Effect.flip)
      expect(b).toBeInstanceOf(TankError)
      const c = yield* worktreeRemove(repoDir, "--force", "bot/alice/p", env).pipe(Effect.flip)
      expect(c).toBeInstanceOf(TankError)
    }),
  )

  it.live("errors never carry credentials embedded in the url", () =>
    Effect.gen(function* () {
      const e = yield* ensureClone(
        join(root, "cred"),
        "https://user:hunter2@127.0.0.1:1/x.git",
        "main",
        env,
      ).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      expect(JSON.stringify(e)).not.toContain("hunter2")
      const bad = yield* ensureClone(join(root, "cred2"), "-u://user:hunter2@host/x", "main", env).pipe(
        Effect.flip,
      )
      expect(JSON.stringify(bad)).not.toContain("hunter2")
    }),
  )

  it("redactUrls masks userinfo and keeps the rest", () => {
    expect(redactUrls("fatal: unable to access 'https://u:tok@github.com/o/r.git/': nope")).toBe(
      "fatal: unable to access 'https://***@github.com/o/r.git/': nope",
    )
    expect(redactUrls("ssh://git@host/x and plain text")).toBe("ssh://***@host/x and plain text")
  })
})
