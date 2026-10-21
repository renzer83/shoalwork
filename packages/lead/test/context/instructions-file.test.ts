import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Option } from "effect"
import { describe, expect } from "vitest"
import type { Briefing } from "../../src/context/briefing.js"
import {
  keepOutOfGit,
  MARKER,
  removeInstructionFiles,
  writeInstructionFiles,
} from "../../src/context/instructions-file.js"
import { localTank, orDie, prepareWorktree, removeDir, scratchRepo } from "./fixtures.js"

const briefing: Pick<Briefing, "text"> = {
  text: [
    "# Role",
    "developer (test)",
    "",
    "# Project memory",
    "- (semantic, bot) The deploy window is Tuesday.",
    "",
    "# Current task",
    "- Title: Add a feature",
  ].join("\n"),
}

// Runs one test in a scratch repo: `run` gets the real Tank and a prepared worktree, and the directory is removed after.
const inWorktree = <A>(
  files: Record<string, string>,
  run: (tank: TankShape, ctx: TankContext, origin: string) => Effect.Effect<A, unknown, Tank>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratchRepo(files)),
    ({ dir, origin }) =>
      Effect.gen(function* () {
        const tank = localTank(dir)
        const ctx = yield* orDie(prepareWorktree(tank, origin))
        return yield* run(tank, ctx, origin).pipe(Effect.provideService(Tank, tank))
      }),
    ({ dir }) => Effect.sync(() => removeDir(dir)),
  )

const gitIn = (tank: TankShape, ctx: TankContext, ...argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* orDie(tank.exec(ctx, ["git", ...argv]))
    return result.stdout
  })

describe("writeInstructionFiles", () => {
  it.effect(
    "writes AGENTS.md and the CLAUDE.md stub, and removes them again",
    () =>
      inWorktree({}, (_tank, ctx) =>
        Effect.gen(function* () {
          const written = yield* writeInstructionFiles(ctx, briefing)
          expect(written).toEqual({ conflict: false })
          const agents = readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8")
          expect(agents.startsWith(`${MARKER}\n# Role\n`)).toBe(true)
          expect(agents).toContain("# Project memory")
          expect(agents).toContain("The deploy window is Tuesday.")
          expect(readFileSync(join(ctx.cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n")

          yield* removeInstructionFiles(ctx)
          expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(false)
          expect(existsSync(join(ctx.cwd, "CLAUDE.md"))).toBe(false)
        }),
      ),
    30_000,
  )

  it.effect(
    "keeps the generated files out of the delivery's git add -A",
    () =>
      inWorktree({}, (tank, ctx) =>
        Effect.gen(function* () {
          yield* writeInstructionFiles(ctx, briefing)
          writeFileSync(join(ctx.cwd, "feature.txt"), "change\n")
          yield* orDie(tank.exec(ctx, ["git", "add", "-A"]))
          expect(yield* gitIn(tank, ctx, "diff", "--cached", "--name-only")).toBe("feature.txt\n")
          expect(yield* gitIn(tank, ctx, "status", "--porcelain")).not.toContain("AGENTS.md")
        }),
      ),
    30_000,
  )

  it.effect(
    "writes the exclude entries once however many times it runs",
    () =>
      inWorktree({}, (tank, ctx) =>
        Effect.gen(function* () {
          yield* writeInstructionFiles(ctx, briefing)
          yield* writeInstructionFiles(ctx, briefing)
          yield* keepOutOfGit(ctx)
          const excludePath = (yield* gitIn(tank, ctx, "rev-parse", "--git-path", "info/exclude")).trim()
          const absolute = excludePath.startsWith("/") ? excludePath : join(ctx.cwd, excludePath)
          const lines = readFileSync(absolute, "utf8").split("\n")
          for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.generated.md"]) {
            expect(lines.filter((line) => line === name)).toHaveLength(1)
          }
        }),
      ),
    30_000,
  )

  it.effect(
    "leaves a repo's own CLAUDE.md alone and writes AGENTS.generated.md instead",
    () =>
      inWorktree({ "CLAUDE.md": "repo instructions\n" }, (_tank, ctx) =>
        Effect.gen(function* () {
          const written = yield* writeInstructionFiles(ctx, briefing)
          expect(written).toEqual({ conflict: true })
          expect(readFileSync(join(ctx.cwd, "CLAUDE.md"), "utf8")).toBe("repo instructions\n")
          expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(false)
          expect(readFileSync(join(ctx.cwd, "AGENTS.generated.md"), "utf8").startsWith(MARKER)).toBe(true)

          yield* removeInstructionFiles(ctx)
          expect(existsSync(join(ctx.cwd, "AGENTS.generated.md"))).toBe(false)
          expect(readFileSync(join(ctx.cwd, "CLAUDE.md"), "utf8")).toBe("repo instructions\n")
        }),
      ),
    30_000,
  )

  it.effect(
    "does not overwrite a repo's own AGENTS.generated.md",
    () =>
      inWorktree({ "CLAUDE.md": "repo\n", "AGENTS.generated.md": "theirs\n" }, (_tank, ctx) =>
        Effect.gen(function* () {
          const failed = yield* writeInstructionFiles(ctx, briefing).pipe(Effect.option)
          expect(Option.isNone(failed)).toBe(true)
          expect(readFileSync(join(ctx.cwd, "AGENTS.generated.md"), "utf8")).toBe("theirs\n")
        }),
      ),
    30_000,
  )

  it.effect(
    "rewrites its own files on a retry in the same worktree",
    () =>
      inWorktree({}, (_tank, ctx) =>
        Effect.gen(function* () {
          yield* writeInstructionFiles(ctx, briefing)
          const second = yield* writeInstructionFiles(ctx, { text: "# Role\nnewer" })
          expect(second).toEqual({ conflict: false })
          expect(readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8")).toContain("newer")
        }),
      ),
    30_000,
  )
})
