import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { TankLocalLive } from "../src/local.js"
import { Tank, type TankContext } from "../src/tank.js"
import { gitEnv, makeBot, stepId, tempDir } from "./helpers.js"

const root = tempDir()
const tankRoot = join(root, "tanks")
const baseEnv = { ...gitEnv(), PATH: process.env.PATH }
const run = <A, E>(eff: Effect.Effect<A, E, Tank>) =>
  eff.pipe(Effect.provide(TankLocalLive({ root: tankRoot, baseEnv })))

// A prepared context for a Bot without repo: its home exists, its cwd is an empty work dir.
const preparedFor = (name: string) =>
  Effect.gen(function* () {
    const tank = yield* Tank
    const ctx = yield* tank.prepare(makeBot(name), { stepId: stepId() })
    return { tank, ctx }
  })

const mode = (path: string): number => statSync(path).mode & 0o777

describe("TankLocal writeHomeFile", () => {
  it.live("writes a file under the Bot's home, creating directories, with the given mode", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("homewrite")
        yield* tank.writeHomeFile(ctx, ".codex/config.toml", "model = 'x'\n", 0o600)
        const target = join(ctx.home, ".codex", "config.toml")
        expect(readFileSync(target, "utf8")).toBe("model = 'x'\n")
        expect(mode(target)).toBe(0o600)
      }),
    ),
  )

  it.live("sets the mode of an existing file it rewrites", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("rewrite")
        yield* tank.writeHomeFile(ctx, "a.txt", "one", 0o600)
        yield* tank.writeHomeFile(ctx, "a.txt", "two", 0o644)
        const target = join(ctx.home, "a.txt")
        expect(readFileSync(target, "utf8")).toBe("two")
        expect(mode(target)).toBe(0o644)
      }),
    ),
  )

  it.live("refuses a path that climbs out of the home", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("climb")
        const error = yield* Effect.flip(tank.writeHomeFile(ctx, "../escape.txt", "x", 0o600))
        expect(error).toBeInstanceOf(TankError)
        expect(existsSync(join(ctx.home, "..", "escape.txt"))).toBe(false)
      }),
    ),
  )

  it.live("refuses an absolute path outside the home", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("absolute")
        const outside = join(root, "absolute-target.txt")
        const error = yield* Effect.flip(tank.writeHomeFile(ctx, outside, "x", 0o600))
        expect(error).toBeInstanceOf(TankError)
        expect(existsSync(outside)).toBe(false)
      }),
    ),
  )

  it.live("refuses to write through a symlink that leads outside the home", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("symlinked")
        const outsideDir = join(root, "symlink-outside")
        mkdirSync(outsideDir, { recursive: true })
        symlinkSync(outsideDir, join(ctx.home, "link"))
        const error = yield* Effect.flip(tank.writeHomeFile(ctx, "link/x.txt", "x", 0o600))
        expect(error).toBeInstanceOf(TankError)
        expect(existsSync(join(outsideDir, "x.txt"))).toBe(false)
      }),
    ),
  )

  it.live("refuses the home itself and the empty path", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("homeitself")
        for (const rel of [".", ""]) {
          const error = yield* Effect.flip(tank.writeHomeFile(ctx, rel, "x", 0o600))
          expect(error).toBeInstanceOf(TankError)
        }
      }),
    ),
  )

  it.live("refuses a mode outside 0..0o777", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("badmode")
        for (const bad of [0o1000, -1, 0.5, Number.NaN]) {
          const error = yield* Effect.flip(tank.writeHomeFile(ctx, "a.txt", "x", bad))
          expect(error).toBeInstanceOf(TankError)
        }
        expect(existsSync(join(ctx.home, "a.txt"))).toBe(false)
      }),
    ),
  )

  it.live("refuses a context whose home is not inside the Bot's directory", () =>
    run(
      Effect.gen(function* () {
        const { tank, ctx } = yield* preparedFor("foreignhome")
        const forged: TankContext = { ...ctx, home: root }
        const error = yield* Effect.flip(tank.writeHomeFile(forged, "escape.txt", "x", 0o600))
        expect(error).toBeInstanceOf(TankError)
        expect(existsSync(join(root, "escape.txt"))).toBe(false)
      }),
    ),
  )
})
