import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError, WorktreeConflict } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { slugRepoUrl, TankLocalLive } from "../src/local.js"
import { Tank } from "../src/tank.js"
import { gitEnv, makeBot, makeOrigin, stepId, tempDir } from "./helpers.js"

const root = tempDir()
const { origin } = makeOrigin(root)
const tankRoot = join(root, "tanks")
const baseEnv = {
  ...gitEnv(),
  ANTHROPIC_API_KEY: "test-key-not-real",
  ANTHROPIC_AUTH_TOKEN: "test-auth-not-real",
  CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-not-real",
  PATH: process.env.PATH,
}
const layer = TankLocalLive({ root: tankRoot, baseEnv })
const run = <A, E>(eff: Effect.Effect<A, E, Tank>) => eff.pipe(Effect.provide(layer))

describe("TankLocal", () => {
  it.live("prepare without repo creates home and an empty work dir, with isolated env", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        expect(tank.mode).toBe("local")
        const bot = makeBot("norepo")
        const step = stepId()
        const ctx = yield* tank.prepare(bot, { stepId: step })
        expect(ctx.home).toBe(join(tankRoot, "norepo", "home"))
        expect(ctx.cwd).toBe(join(tankRoot, "norepo", "work", step))
        expect(ctx.worktree).toBeUndefined()
        expect(existsSync(join(ctx.home, ".claude"))).toBe(true)
        expect(ctx.env.HOME).toBe(ctx.home)
        expect(ctx.env.CLAUDE_CONFIG_DIR).toBe(join(ctx.home, ".claude"))
        expect(ctx.env.CODEX_HOME).toBe(join(ctx.home, ".codex"))
        expect(ctx.env.GEMINI_CLI_HOME).toBe(ctx.home)
        for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
          expect(key in ctx.env).toBe(false)
        }
        expect(ctx.env.PATH).toBe(process.env.PATH)
        yield* tank.release(ctx, { keepWorktree: false })
        expect(existsSync(ctx.cwd)).toBe(false)
        expect(existsSync(ctx.home)).toBe(true)
      }),
    ),
  )

  it.live("prepare with repo makes a worktree on bot/<name>/<stepId>; release removes it", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("withrepo")
        const step = stepId()
        const ctx = yield* tank.prepare(bot, { stepId: step, repo: { url: origin, base: "main" } })
        const branch = `bot/withrepo/${step}`
        expect(ctx.worktree).toEqual({
          path: join(tankRoot, "withrepo", "work", step),
          branch,
          repoDir: join(tankRoot, "withrepo", "repos", slugRepoUrl(origin)),
        })
        expect(ctx.cwd).toBe(ctx.worktree?.path)
        expect(existsSync(join(ctx.cwd, "README.txt"))).toBe(true)
        const head = yield* tank.exec(ctx, ["git", "rev-parse", "--abbrev-ref", "HEAD"])
        expect(head.stdout.trim()).toBe(branch)

        yield* tank.release(ctx, { keepWorktree: false })
        expect(existsSync(ctx.cwd)).toBe(false)
        const branches = execFileSync("git", ["branch", "--list", "bot/*"], {
          cwd: ctx.worktree?.repoDir,
          encoding: "utf8",
        })
        expect(branches.trim()).toBe("")
      }),
    ),
  )

  it.live("release with keepWorktree leaves the worktree in place", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("keeper"), {
          stepId: stepId(),
          repo: { url: origin, base: "main" },
        })
        yield* tank.release(ctx, { keepWorktree: true })
        expect(existsSync(join(ctx.cwd, "README.txt"))).toBe(true)
      }),
    ),
  )

  it.live("preparing the same step twice fails with WorktreeConflict", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("twice")
        const step = { stepId: stepId(), repo: { url: origin, base: "main" } }
        yield* tank.prepare(bot, step)
        const e = yield* tank.prepare(bot, step).pipe(Effect.flip)
        expect(e).toBeInstanceOf(WorktreeConflict)
      }),
    ),
  )

  it.live("parallel steps of one bot share the base clone without racing", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("parallel")
        const ctxs = yield* Effect.forEach(
          [stepId(), stepId(), stepId()],
          (s) => tank.prepare(bot, { stepId: s, repo: { url: origin, base: "main" } }),
          { concurrency: "unbounded" },
        )
        expect(new Set(ctxs.map((c) => c.cwd)).size).toBe(3)
        expect(readdirSync(join(tankRoot, "parallel", "repos"))).toHaveLength(1)
      }),
    ),
  )

  it.live("exec runs inside cwd with the Bot env and honours timeouts", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("runner"), { stepId: stepId() })
        const r = yield* tank.exec(ctx, [
          "sh",
          "-c",
          `pwd; echo "$HOME"; echo "\${ANTHROPIC_API_KEY-unset}"; echo "\${ANTHROPIC_AUTH_TOKEN-unset}"; echo "\${CLAUDE_CODE_OAUTH_TOKEN-unset}"`,
        ])
        expect(r.stdout.trim().split("\n")).toEqual([ctx.cwd, ctx.home, "unset", "unset", "unset"])
        const t = yield* tank.exec(ctx, ["sleep", "5.23"], { timeoutMs: 150 })
        expect(t.timedOut).toBe(true)
      }),
    ),
  )

  it.live("writeFile and readFile stay inside the worktree", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("files"), { stepId: stepId() })
        yield* tank.writeFile(ctx, "notes/a.txt", "hello")
        expect(yield* tank.readFile(ctx, "notes/a.txt")).toBe("hello")
        const escapeRead = yield* tank.readFile(ctx, "../../../home/.claude/x").pipe(Effect.flip)
        expect(escapeRead).toBeInstanceOf(TankError)
        const escapeWrite = yield* tank.writeFile(ctx, "/etc/shoalwork-test", "x").pipe(Effect.flip)
        expect(escapeWrite).toBeInstanceOf(TankError)
        const missing = yield* tank.readFile(ctx, "absent.txt").pipe(Effect.flip)
        expect(missing).toBeInstanceOf(TankError)
      }),
    ),
  )

  it.live("prepare rejects path-unsafe bot names", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        for (const name of ["../escape", "a/b", "-dash", ""]) {
          const e = yield* tank
            .prepare({ ...makeBot("unsafe"), name }, { stepId: stepId() })
            .pipe(Effect.flip)
          expect(e).toBeInstanceOf(TankError)
        }
        expect(existsSync(join(tankRoot, "..", "escape"))).toBe(false)
      }),
    ),
  )

  it.live("readFile and writeFile refuse to follow symlinks out of the worktree", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("symlinks"), { stepId: stepId() })
        const outside = join(root, "outside")
        mkdirSync(outside, { recursive: true })
        writeFileSync(join(outside, "secret.txt"), "top secret")
        symlinkSync(outside, join(ctx.cwd, "dirlink"))
        symlinkSync(join(outside, "secret.txt"), join(ctx.cwd, "filelink"))
        symlinkSync(join(outside, "not-yet.txt"), join(ctx.cwd, "dangling"))

        for (const rel of ["dirlink/secret.txt", "filelink", "dirlink"]) {
          expect(yield* tank.readFile(ctx, rel).pipe(Effect.flip)).toBeInstanceOf(TankError)
        }
        for (const rel of ["dirlink/new.txt", "dirlink/sub/new.txt", "filelink", "dangling"]) {
          expect(yield* tank.writeFile(ctx, rel, "pwned").pipe(Effect.flip)).toBeInstanceOf(TankError)
        }
        expect(readdirSync(outside)).toEqual(["secret.txt"])
        expect(yield* tank.exec(ctx, ["cat", join(outside, "secret.txt")])).toMatchObject({ exitCode: 0 })
      }),
    ),
  )

  it.live("symlinks that stay inside the worktree keep working", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("insidelink"), { stepId: stepId() })
        yield* tank.writeFile(ctx, "real/a.txt", "inside")
        symlinkSync(join(ctx.cwd, "real"), join(ctx.cwd, "alias"))
        expect(yield* tank.readFile(ctx, "alias/a.txt")).toBe("inside")
        yield* tank.writeFile(ctx, "alias/b.txt", "also inside")
        expect(yield* tank.readFile(ctx, "real/b.txt")).toBe("also inside")
      }),
    ),
  )

  it.live("release refuses forged contexts and deletes nothing outside the Bot's own dirs", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const ctx = yield* tank.prepare(makeBot("forged"), { stepId: stepId() })
        const victim = join(root, "victim")
        mkdirSync(victim, { recursive: true })
        writeFileSync(join(victim, "keep.txt"), "keep")
        const forgedCwd = { ...ctx, cwd: victim }
        expect(yield* tank.release(forgedCwd, { keepWorktree: false }).pipe(Effect.flip)).toBeInstanceOf(
          TankError,
        )
        const forgedName = { ...ctx, botName: "../.." }
        expect(yield* tank.release(forgedName, { keepWorktree: false }).pipe(Effect.flip)).toBeInstanceOf(
          TankError,
        )
        const forgedWork = { ...ctx, cwd: join(tankRoot, "forged", "work") }
        expect(yield* tank.release(forgedWork, { keepWorktree: false }).pipe(Effect.flip)).toBeInstanceOf(
          TankError,
        )
        const forgedTree = {
          ...ctx,
          worktree: { path: victim, branch: "bot/forged/x", repoDir: victim },
        }
        expect(yield* tank.release(forgedTree, { keepWorktree: false }).pipe(Effect.flip)).toBeInstanceOf(
          TankError,
        )
        expect(existsSync(join(victim, "keep.txt"))).toBe(true)
        expect(existsSync(ctx.cwd)).toBe(true)
      }),
    ),
  )

  it.live("prepare rejects path-unsafe step ids", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bad = "../escape" as ReturnType<typeof stepId>
        const e = yield* tank.prepare(makeBot("unsafe"), { stepId: bad }).pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
      }),
    ),
  )
})

describe("slugRepoUrl", () => {
  it("is filesystem-safe, stable and collision-resistant", () => {
    const a = slugRepoUrl("https://github.com/renzer83/shoalwork.git")
    expect(a).toMatch(/^[a-z0-9-]+$/)
    expect(slugRepoUrl("https://github.com/renzer83/shoalwork.git")).toBe(a)
    expect(slugRepoUrl("https://github.com/renzer83/shoalwork-git")).not.toBe(a)
  })
})
