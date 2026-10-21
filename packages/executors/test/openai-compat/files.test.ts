import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import type { ToolCall } from "@shoalwork/contracts"
import { makeTankLocal, type TankContext } from "@shoalwork/tank"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import { FILE_MAX_BYTES, runTool, type ToolDeps, type ToolOutcome } from "../../src/openai-compat/tools.js"
import { BOT, policyOf } from "./harness.js"

// The tools against the real local Tank: confinement and file type are decided by the filesystem, not by a fake.
const root = realpathSync(mkdtempSync(join(tmpdir(), "oai-files-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const cwd = join(root, "bot", "work")
const outside = join(root, "outside")
mkdirSync(cwd, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(cwd, "plain.txt"), "plain content")
writeFileSync(join(cwd, "..dots"), "dots content")
mkdirSync(join(cwd, "secret"))
writeFileSync(join(cwd, "secret", ".env"), "KEY=original")
symlinkSync("secret/.env", join(cwd, "env-link"))
symlinkSync("secret/.env", join(cwd, "env-link-pending"))
writeFileSync(join(outside, "secret.txt"), "TOP SECRET")
writeFileSync(join(cwd, "big.bin"), Buffer.alloc(FILE_MAX_BYTES + 1, 97))
mkdirSync(join(cwd, "dir"))
execFileSync("mkfifo", [join(cwd, "pipe")])
symlinkSync("/dev/zero", join(cwd, "zero-link"))
symlinkSync(join(outside, "secret.txt"), join(cwd, "out-link"))
symlinkSync(join(outside, "missing.txt"), join(cwd, "dangling-out"))
symlinkSync("plain.txt", join(cwd, "in-link"))

const ctx: TankContext = {
  botId: BOT,
  botName: "bot",
  cwd,
  home: join(root, "bot", "home"),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
}
const tank = makeTankLocal({ root, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })

const deps = (policy = policyOf("allow")): { deps: ToolDeps; seen: Array<ToolCall> } => ({
  deps: { tank, ctx, botId: BOT, policy: policy.policy, mode: "edit" },
  seen: policy.seen,
})

const contentOf = (outcome: ToolOutcome): string => (outcome.kind === "result" ? outcome.content : "ASK")

const read = (path: string, d = deps().deps) => runTool(d, "read_file", JSON.stringify({ path }))

const NOT_READABLE = "error: not a readable regular file inside the workspace"

describe("openai-compat read_file on the real Tank", () => {
  it.live("reads a regular file by relative and by absolute path", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("plain.txt"))).toBe("plain content")
      expect(contentOf(yield* read(join(cwd, "plain.txt")))).toBe("plain content")
      expect(contentOf(yield* read("..dots"))).toBe("dots content")
    }),
  )

  it.live("follows a symlink that stays inside, and the policy sees the real path", () =>
    Effect.gen(function* () {
      const { deps: d, seen } = deps()
      expect(contentOf(yield* read("in-link", d))).toBe("plain content")
      expect(seen).toMatchObject([{ tool: "Read", resource: join(cwd, "plain.txt") }])
    }),
  )

  it.live("an absolute path outside the workspace is refused before anything is probed", () =>
    Effect.gen(function* () {
      const { deps: d, seen } = deps()
      expect(contentOf(yield* read(join(outside, "secret.txt"), d))).toBe(
        "error: path is outside the workspace",
      )
      expect(seen).toEqual([])
    }),
  )

  it.live("a symlink to a file outside is refused and leaks neither content nor existence", () =>
    Effect.gen(function* () {
      const { deps: d, seen } = deps()
      const linked = contentOf(yield* read("out-link", d))
      expect(linked).toBe(NOT_READABLE)
      expect(linked).not.toContain("SECRET")
      expect(contentOf(yield* read("dangling-out", d))).toBe(linked)
      expect(contentOf(yield* read("no-such-file.txt", d))).toBe(linked)
      expect(seen).toEqual([])
    }),
  )

  it.live("a symlink to /dev/zero returns at once instead of reading forever", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("zero-link"))).toBe(NOT_READABLE)
    }),
  )

  it.live("a FIFO inside the workspace returns at once instead of blocking", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("pipe"))).toBe(NOT_READABLE)
    }),
  )

  it.live("a directory is not a readable file", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("dir"))).toBe(NOT_READABLE)
    }),
  )

  it.live("a NUL in the path is refused", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("plain.txt\0.png"))).toBe("error: invalid path")
    }),
  )

  it.live("a file over the size limit is refused", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* read("big.bin"))).toContain("larger than")
    }),
  )
})

describe("openai-compat write_file and run_command on the real Tank", () => {
  it.live("writes a regular file and replaces it", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* write("new.txt", "one"))).toContain("wrote 3 bytes")
      expect(contentOf(yield* write("new.txt", "two"))).toContain("wrote 3 bytes")
      expect(contentOf(yield* read("new.txt"))).toBe("two")
    }),
  )

  it.live("refuses to write into a FIFO or through a link that leaves the workspace", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* write("pipe", "x"))).toBe("error: target is not a regular file")
      expect(contentOf(yield* write("out-link", "x"))).toBe("error: path is outside the workspace")
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET")
    }),
  )

  it.live("cuts the output of an endless command at the cap and stops it", () =>
    Effect.gen(function* () {
      const out = contentOf(yield* runTool(deps().deps, "run_command", JSON.stringify({ cmd: ["yes"] })))
      expect(out).toContain("the command was stopped")
      expect(out.length).toBeLessThan(9 * 1024)
    }),
  )
})

const write = (path: string, content: string) =>
  runTool(deps().deps, "write_file", JSON.stringify({ path, content }))

describe("openai-compat write_file judges the path that is really written", () => {
  const denyEnv = () => policyOf((call) => (String(call.resource).endsWith(".env") ? "deny" : "allow"))

  it.live("a link to a denied file is denied and the file stays intact", () =>
    Effect.gen(function* () {
      const { deps: d, seen } = deps(denyEnv())
      const out = yield* runTool(d, "write_file", JSON.stringify({ path: "env-link", content: "PWNED" }))
      expect(contentOf(out)).toContain("denied")
      expect(seen).toMatchObject([{ tool: "Write", resource: join(cwd, "secret", ".env") }])
      expect(readFileSync(join(cwd, "secret", ".env"), "utf8")).toBe("KEY=original")
    }),
  )

  it.live("a new file in a new directory is judged at its place in the workspace", () =>
    Effect.gen(function* () {
      const { deps: d, seen } = deps()
      const out = yield* runTool(d, "write_file", JSON.stringify({ path: "fresh/deep/a.txt", content: "ok" }))
      expect(contentOf(out)).toContain("wrote 2 bytes")
      expect(seen).toMatchObject([{ resource: join(cwd, "fresh", "deep", "a.txt") }])
      expect(readFileSync(join(cwd, "fresh", "deep", "a.txt"), "utf8")).toBe("ok")
    }),
  )

  it.live("a name that starts with two dots is writable", () =>
    Effect.gen(function* () {
      expect(contentOf(yield* write("..notes", "n"))).toContain("wrote 1 bytes")
    }),
  )
})
