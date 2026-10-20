import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError, WorktreeConflict } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { worktreeReuse } from "../src/git.js"
import { TankLocalLive } from "../src/local.js"
import { Tank } from "../src/tank.js"
import { makeBot, makeOrigin, stepId, tempDir } from "./helpers.js"

const root = tempDir("tank-reuse-")
const { origin } = makeOrigin(root)
const tankRoot = join(root, "tanks")
const layer = TankLocalLive({ root: tankRoot, baseEnv: { PATH: process.env.PATH } })
const run = <A, E>(eff: Effect.Effect<A, E, Tank>) => eff.pipe(Effect.provide(layer))
const repo = { url: origin, base: "main" }

describe("TankLocal prepare with reuse", () => {
  it.live("continues the kept worktree: uncommitted work of the earlier attempt is still there", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("continue")
        const step = stepId()
        const first = yield* tank.prepare(bot, { stepId: step, repo })
        writeFileSync(join(first.cwd, "partial.txt"), "half done\n")
        yield* tank.release(first, { keepWorktree: true })

        const second = yield* tank.prepare(bot, {
          stepId: step,
          repo,
          reuse: { path: first.worktree?.path ?? "", branch: first.worktree?.branch ?? "" },
        })
        expect(second.cwd).toBe(first.cwd)
        expect(second.worktree?.branch).toBe(first.worktree?.branch)
        expect(readFileSync(join(second.cwd, "partial.txt"), "utf8")).toBe("half done\n")
        yield* tank.release(second, { keepWorktree: false })
        expect(existsSync(first.cwd)).toBe(false)
      }),
    ),
  )

  it.live("reuse fails with TankError when the kept worktree is gone", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("gone")
        const step = stepId()
        const first = yield* tank.prepare(bot, { stepId: step, repo })
        yield* tank.release(first, { keepWorktree: false })
        const e = yield* tank
          .prepare(bot, {
            stepId: step,
            repo,
            reuse: { path: first.worktree?.path ?? "", branch: first.worktree?.branch ?? "" },
          })
          .pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
      }),
    ),
  )

  it.live("reuse is refused when it names the worktree of another step", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("foreign")
        const mine = stepId()
        const other = stepId()
        const theirs = yield* tank.prepare(bot, { stepId: other, repo })
        const e = yield* tank
          .prepare(bot, {
            stepId: mine,
            repo,
            reuse: { path: theirs.worktree?.path ?? "", branch: theirs.worktree?.branch ?? "" },
          })
          .pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
        expect(e).toMatchObject({ cause: "reuse does not match the step" })
      }),
    ),
  )

  it.live("without reuse a kept worktree still blocks a prepare of the same step", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("kept")
        const step = stepId()
        const first = yield* tank.prepare(bot, { stepId: step, repo })
        yield* tank.release(first, { keepWorktree: true })
        const e = yield* tank.prepare(bot, { stepId: step, repo }).pipe(Effect.flip)
        expect(e).toBeInstanceOf(WorktreeConflict)
      }),
    ),
  )

  it.live("reuse refuses a symlink swapped in where the kept worktree was", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("swapped")
        const step = stepId()
        const first = yield* tank.prepare(bot, { stepId: step, repo })
        yield* tank.release(first, { keepWorktree: true })
        const elsewhere = join(root, "elsewhere")
        mkdirSync(elsewhere, { recursive: true })
        rmSync(first.cwd, { recursive: true, force: true })
        symlinkSync(elsewhere, first.cwd)
        const e = yield* tank
          .prepare(bot, {
            stepId: step,
            repo,
            reuse: { path: first.worktree?.path ?? "", branch: first.worktree?.branch ?? "" },
          })
          .pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
      }),
    ),
  )
})

describe("worktreeReuse", () => {
  it.live("accepts the worktree registered for this branch at this path", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("direct")
        const ctx = yield* tank.prepare(bot, { stepId: stepId(), repo })
        const workDir = join(tankRoot, "direct", "work")
        yield* worktreeReuse(
          ctx.worktree?.repoDir ?? "",
          ctx.cwd,
          ctx.worktree?.branch ?? "",
          workDir,
          ctx.env,
        )
        yield* tank.release(ctx, { keepWorktree: false })
      }),
    ),
  )

  it.live("refuses a branch that no worktree of the repo is registered for", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("branchdiff")
        const ctx = yield* tank.prepare(bot, { stepId: stepId(), repo })
        const workDir = join(tankRoot, "branchdiff", "work")
        const e = yield* worktreeReuse(
          ctx.worktree?.repoDir ?? "",
          ctx.cwd,
          `bot/branchdiff/${stepId()}`,
          workDir,
          ctx.env,
        ).pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
      }),
    ),
  )

  it.live("refuses a path other than the one the branch is registered at", () =>
    run(
      Effect.gen(function* () {
        const tank = yield* Tank
        const bot = makeBot("pathdiff")
        const mine = yield* tank.prepare(bot, { stepId: stepId(), repo })
        const theirs = yield* tank.prepare(bot, { stepId: stepId(), repo })
        const workDir = join(tankRoot, "pathdiff", "work")
        // The branch of `mine` exists, but at its own path: the second worktree's path must not be accepted for it.
        const e = yield* worktreeReuse(
          mine.worktree?.repoDir ?? "",
          theirs.cwd,
          mine.worktree?.branch ?? "",
          workDir,
          mine.env,
        ).pipe(Effect.flip)
        expect(e).toBeInstanceOf(TankError)
      }),
    ),
  )
})
