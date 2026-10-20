import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { newTaskId, TankError, type TaskId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ARTIFACTS_DIR_MODE, type ArtifactScreen, artifactsDir, type PublishRun } from "../src/artifacts.js"
import { ARTIFACTS_GROUP, makeTankServer, type RunFn } from "../src/server.js"
import type { TankShape } from "../src/tank.js"
import { makeBot, tempDir } from "./helpers.js"

const screen: ArtifactScreen = { refusePath: () => false, refuseContent: () => false }
const baseEnv = { PATH: "/usr/bin:/bin" }

// Fake command runner: records every argv the server Tank runs as the core, and answers with `exitCode`.
const fakeRun = (exitCode: number) => {
  const calls: Array<ReadonlyArray<string>> = []
  const run: RunFn = (cmd) =>
    Effect.sync(() => {
      calls.push(cmd)
      return {
        exitCode,
        stdout: "",
        stderr: exitCode === 0 ? "" : "chgrp: invalid group",
        durationMs: 0,
        timedOut: false,
      }
    })
  return { calls, run }
}

// Both real Tanks provide the publisher; the field is optional on the shape only for test doubles.
const publish = (tank: TankShape, input: PublishRun) => {
  const run = tank.publishArtifacts
  if (run === undefined) throw new Error("the server Tank has no artifacts publisher")
  return run(input)
}

// A worktree with one file, and an artifacts root that stands in for the Bot homes root.
const setup = () => {
  const artifactsRoot = tempDir("server-artifacts-root-")
  const cwd = join(tempDir("server-artifacts-cwd-"), "work")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, "report.md"), "# report\n")
  return { artifactsRoot, cwd, bot: makeBot("alice"), taskId: newTaskId() as TaskId }
}

describe("server mode artifacts (T-172)", () => {
  it("gives the task directory the shared group through the core's own runner, never through sudo", async () => {
    const ctx = setup()
    const fake = fakeRun(0)
    const tank = makeTankServer({ baseEnv, sudo: true, run: fake.run, artifactsRoot: ctx.artifactsRoot })
    const dir = artifactsDir(ctx.artifactsRoot, ctx.taskId)

    await Effect.runPromise(
      publish(tank, {
        taskId: ctx.taskId,
        producedBy: ctx.bot.id,
        cwd: ctx.cwd,
        files: ["report.md"],
        screen,
      }),
    )

    expect(fake.calls).toEqual([["chgrp", "--", ARTIFACTS_GROUP, dir]])
    expect(ARTIFACTS_GROUP).toBe("bots")
    expect(existsSync(join(dir, "report.md"))).toBe(true)
    expect(existsSync(join(dir, "manifest.json"))).toBe(true)
  })

  it("asks for the setgid 2775 directory, so the files it receives inherit the group", () => {
    // The requested mode is checked, not the effective bit: the host may clear setgid on a directory the user does not own
    // a group of (macOS tmp), which is not what this code controls.
    expect(ARTIFACTS_DIR_MODE).toBe(0o2775)
  })

  it("publishes nothing and creates no directory when the run has no files", async () => {
    const ctx = setup()
    const fake = fakeRun(0)
    const tank = makeTankServer({ baseEnv, sudo: true, run: fake.run, artifactsRoot: ctx.artifactsRoot })
    const dir = artifactsDir(ctx.artifactsRoot, ctx.taskId)

    const published = await Effect.runPromise(
      publish(tank, { taskId: ctx.taskId, producedBy: ctx.bot.id, cwd: ctx.cwd, files: [], screen }),
    )

    expect(published).toEqual({ manifest: { files: [] }, artifacts: [] })
    expect(fake.calls).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  it("a refused group fails the publication before the first file is written", async () => {
    const ctx = setup()
    const fake = fakeRun(1)
    const tank = makeTankServer({ baseEnv, sudo: true, run: fake.run, artifactsRoot: ctx.artifactsRoot })
    const dir = artifactsDir(ctx.artifactsRoot, ctx.taskId)

    const error = await Effect.runPromise(
      publish(tank, {
        taskId: ctx.taskId,
        producedBy: ctx.bot.id,
        cwd: ctx.cwd,
        files: ["report.md"],
        screen,
      }).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(TankError)
    expect(error.op).toBe("artifacts")
    expect(existsSync(join(dir, "report.md"))).toBe(false)
    expect(existsSync(join(dir, "manifest.json"))).toBe(false)
  })
})
