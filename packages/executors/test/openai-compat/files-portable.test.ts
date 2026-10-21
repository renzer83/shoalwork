import { it } from "@effect/vitest"
import { TankError, type ToolCall } from "@shoalwork/contracts"
import type { ExecResult, TankContext, TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { runTool, type ToolDeps, type ToolOutcome } from "../../src/openai-compat/tools.js"
import { BOT, CWD, ctx, fakeTank, policyOf } from "./harness.js"

// The file tools with a fake filesystem whose `realpath` behaves like each platform's, so the outcome does not depend
// on the machine running the suite. For a path whose last component is missing, GNU realpath (coreutils, default
// mode) succeeds when the parent exists; BSD/macOS realpath fails.
type Semantics = "gnu" | "bsd"

const NOT_READABLE = "error: not a readable regular file inside the workspace"
const DIRS = new Set(["/", "/tank", "/tank/bot-a", "/tank/bot-a/work", CWD, ctx.home])

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/"

const result = (exitCode: number, stdout = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr: "",
  durationMs: 0,
  timedOut: false,
})

const fakeWorld = (semantics: Semantics, initial: Readonly<Record<string, string>>) => {
  const files = new Map<string, string>(Object.entries(initial))
  const written: Array<{ readonly path: string; readonly content: string }> = []
  const exists = (path: string): boolean => files.has(path) || DIRS.has(path)
  const realpathSucceeds = (path: string): boolean =>
    semantics === "gnu" ? exists(path) || exists(parentOf(path)) : exists(path)

  const exec = (_ctx: TankContext, cmd: ReadonlyArray<string>): ExecResult => {
    const path = cmd[2] ?? ""
    switch (cmd[0]) {
      case "realpath":
        return realpathSucceeds(path) ? result(0, `${path}\n`) : result(1)
      case "test":
        return result(cmd[1] === "-f" ? (files.has(path) ? 0 : 1) : exists(path) ? 0 : 1)
      case "wc": {
        const content = files.get(path)
        return content === undefined ? result(1) : result(0, `${Buffer.byteLength(content)} ${path}\n`)
      }
      default:
        return result(1)
    }
  }

  const shape: TankShape = {
    ...fakeTank().shape,
    exec: (c, cmd) => Effect.sync(() => exec(c, cmd)),
    readFile: (_c, path) => {
      const content = files.get(path)
      return content === undefined
        ? Effect.fail(new TankError({ op: "read", cause: "missing" }))
        : Effect.succeed(content)
    },
    writeFile: (_c, path, content) =>
      Effect.sync(() => {
        files.set(path, content)
        written.push({ path, content })
      }),
  }
  return { shape, files, written }
}

const depsOf = (semantics: Semantics, initial: Readonly<Record<string, string>>) => {
  const world = fakeWorld(semantics, initial)
  const policy = policyOf("allow")
  const deps: ToolDeps = { tank: world.shape, ctx, botId: BOT, policy: policy.policy, mode: "edit" }
  return { deps, seen: policy.seen, files: world.files, written: world.written }
}

const contentOf = (outcome: ToolOutcome): string => (outcome.kind === "result" ? outcome.content : "ASK")

describe.each<Semantics>(["gnu", "bsd"])("openai-compat file tools when realpath follows %s", (semantics) => {
  it.effect("read_file of a missing file is NOT_READABLE and the Policy never judges it", () =>
    Effect.gen(function* () {
      for (const path of ["no-such-file.txt", "no-dir/no-such-file.txt"]) {
        const { deps, seen } = depsOf(semantics, { [`${CWD}/plain.txt`]: "plain content" })
        expect(contentOf(yield* runTool(deps, "read_file", JSON.stringify({ path })))).toBe(NOT_READABLE)
        expect(seen).toEqual([])
      }
    }),
  )

  it.effect("read_file of an existing file still reaches the Policy and returns its content", () =>
    Effect.gen(function* () {
      const { deps, seen } = depsOf(semantics, { [`${CWD}/plain.txt`]: "plain content" })
      expect(contentOf(yield* runTool(deps, "read_file", JSON.stringify({ path: "plain.txt" })))).toBe(
        "plain content",
      )
      const expected: Partial<ToolCall> = { tool: "Read", resource: `${CWD}/plain.txt` }
      expect(seen).toMatchObject([expected])
    }),
  )

  it.effect("write_file of a new file in the worktree is judged and written", () =>
    Effect.gen(function* () {
      const { deps, seen, files, written } = depsOf(semantics, {})
      const out = yield* runTool(deps, "write_file", JSON.stringify({ path: "fresh.txt", content: "one" }))
      expect(contentOf(out)).toContain("wrote 3 bytes to fresh.txt")
      const expected: Partial<ToolCall> = { tool: "Write", resource: `${CWD}/fresh.txt` }
      expect(seen).toMatchObject([expected])
      expect(written).toEqual([{ path: `${CWD}/fresh.txt`, content: "one" }])
      expect(files.get(`${CWD}/fresh.txt`)).toBe("one")
    }),
  )

  it.effect("write_file of a new file in a new directory is judged at its place in the worktree", () =>
    Effect.gen(function* () {
      const { deps, seen, written } = depsOf(semantics, {})
      const out = yield* runTool(
        deps,
        "write_file",
        JSON.stringify({ path: "fresh/deep/a.txt", content: "ok" }),
      )
      expect(contentOf(out)).toContain("wrote 2 bytes")
      expect(seen).toMatchObject([{ resource: `${CWD}/fresh/deep/a.txt` }])
      expect(written).toEqual([{ path: `${CWD}/fresh/deep/a.txt`, content: "ok" }])
    }),
  )
})
