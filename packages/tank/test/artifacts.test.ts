import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { newTaskId, TankError, type TaskId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  type ArtifactScreen,
  artifactsDir,
  MANIFEST_NAME,
  publishArtifacts,
  readArtifactManifest,
} from "../src/artifacts.js"
import { makeBot, tempDir } from "./helpers.js"

const screen: ArtifactScreen = {
  refusePath: (path) => path.startsWith(".env"),
  refuseContent: (text) => text.includes("SECRET-MARK"),
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex")

// A worktree with a few files, and a Tank root next to it.
const setup = () => {
  const root = tempDir("artifacts-root-")
  const cwd = join(tempDir("artifacts-cwd-"), "work")
  mkdirSync(join(cwd, "reports"), { recursive: true })
  writeFileSync(join(cwd, "report.md"), "# report\nall green\n")
  writeFileSync(join(cwd, "reports", "trace.txt"), "line 1\nline 2\n")
  const bot = makeBot("alice")
  const taskId: TaskId = newTaskId()
  return { root, cwd, bot, taskId }
}

const publish = (
  ctx: ReturnType<typeof setup>,
  files: ReadonlyArray<string>,
  limits?: { readonly maxFileBytes: number; readonly maxTotalBytes: number },
) =>
  publishArtifacts({
    root: ctx.root,
    taskId: ctx.taskId,
    producedBy: ctx.bot.id,
    cwd: ctx.cwd,
    files,
    screen,
    ...(limits === undefined ? {} : { limits }),
  })

describe("artifacts", () => {
  it("places the task's artifacts under <root>/_shared/artifacts/<taskId>", () => {
    const root = "/tmp/tank-root"
    const taskId = newTaskId()
    expect(artifactsDir(root, taskId)).toBe(`/tmp/tank-root/_shared/artifacts/${taskId}`)
  })

  it.effect("copies the files and writes a manifest that decodes back with sha256 and size", () => {
    const ctx = setup()
    return Effect.gen(function* () {
      const published = yield* publish(ctx, ["report.md", "reports/trace.txt"])
      const dir = artifactsDir(ctx.root, ctx.taskId)

      expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# report\nall green\n")
      expect(readFileSync(join(dir, "reports", "trace.txt"), "utf8")).toBe("line 1\nline 2\n")

      const manifest = yield* readArtifactManifest(ctx.root, ctx.taskId)
      expect(manifest.files).toEqual([
        {
          path: "report.md",
          sha256: sha("# report\nall green\n"),
          bytes: Buffer.byteLength("# report\nall green\n"),
          producedBy: ctx.bot.id,
        },
        {
          path: "reports/trace.txt",
          sha256: sha("line 1\nline 2\n"),
          bytes: Buffer.byteLength("line 1\nline 2\n"),
          producedBy: ctx.bot.id,
        },
      ])
      expect(published.manifest).toEqual(manifest)
      expect(published.artifacts).toEqual([
        { kind: "file", ref: join(dir, "report.md") },
        { kind: "file", ref: join(dir, "reports", "trace.txt") },
      ])
    })
  })

  it.effect("refuses a source that is a symlink and publishes nothing", () => {
    const ctx = setup()
    symlinkSync("/etc/hosts", join(ctx.cwd, "link.txt"))
    return Effect.gen(function* () {
      const error = yield* Effect.flip(publish(ctx, ["report.md", "link.txt"]))
      expect(error).toBeInstanceOf(TankError)
      expect(existsSync(join(artifactsDir(ctx.root, ctx.taskId), "report.md"))).toBe(false)
    })
  })

  it.effect("refuses path traversal, absolute paths and the reserved manifest name", () => {
    const ctx = setup()
    return Effect.gen(function* () {
      for (const bad of ["../outside.txt", "/etc/hosts", "reports/../../x", MANIFEST_NAME]) {
        expect(yield* Effect.flip(publish(ctx, [bad]))).toBeInstanceOf(TankError)
      }
    })
  })

  it.effect("refuses a file over the per-file limit and a set over the total limit", () => {
    const ctx = setup()
    return Effect.gen(function* () {
      expect(
        yield* Effect.flip(publish(ctx, ["report.md"], { maxFileBytes: 4, maxTotalBytes: 1000 })),
      ).toBeInstanceOf(TankError)
      expect(
        yield* Effect.flip(
          publish(ctx, ["report.md", "reports/trace.txt"], { maxFileBytes: 1000, maxTotalBytes: 20 }),
        ),
      ).toBeInstanceOf(TankError)
    })
  })

  it.effect("refuses secrets by name and by content", () => {
    const ctx = setup()
    writeFileSync(join(ctx.cwd, ".env"), "TOKEN=1\n")
    writeFileSync(join(ctx.cwd, "notes.txt"), "SECRET-MARK inside\n")
    return Effect.gen(function* () {
      expect(yield* Effect.flip(publish(ctx, [".env"]))).toBeInstanceOf(TankError)
      expect(yield* Effect.flip(publish(ctx, ["notes.txt"]))).toBeInstanceOf(TankError)
      expect(existsSync(join(artifactsDir(ctx.root, ctx.taskId), "notes.txt"))).toBe(false)
    })
  })

  it.effect("refuses a path listed twice", () => {
    const ctx = setup()
    return Effect.gen(function* () {
      expect(yield* Effect.flip(publish(ctx, ["report.md", "report.md"]))).toBeInstanceOf(TankError)
    })
  })

  it.effect("rejects a manifest that does not match the schema when read back", () => {
    const ctx = setup()
    return Effect.gen(function* () {
      yield* publish(ctx, ["report.md"])
      writeFileSync(
        join(artifactsDir(ctx.root, ctx.taskId), MANIFEST_NAME),
        JSON.stringify({ files: [{ path: "x" }] }),
      )
      expect(yield* Effect.flip(readArtifactManifest(ctx.root, ctx.taskId))).toBeInstanceOf(TankError)
    })
  })
})
