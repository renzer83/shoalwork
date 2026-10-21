import { basename, dirname, relative, resolve } from "node:path"
import type { ToolCall } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import {
  clip,
  FILE_MAX_BYTES,
  failed,
  insideCwd,
  invalidPath,
  isInside,
  judge,
  PROBE_TIMEOUT_MS,
  parseArgs,
  probe,
  READ_OUTPUT_MAX_CHARS,
  type ToolDeps,
  type ToolOutcome,
  tankMessage,
} from "./tool-common.js"

export const ReadArgs = Schema.Struct({ path: Schema.String.check(Schema.isMinLength(1)) })
export const WriteArgs = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  content: Schema.String,
})

// One message for every way a path can be unreadable (missing, FIFO, device, directory, link out of the workspace):
// the model learns nothing about files it may not read.
const NOT_READABLE = "not a readable regular file inside the workspace"

const MAX_WALK = 64

const lineOf = (stdout: string): string => stdout.replace(/\r?\n$/, "")

// The workspace path of a real path, or undefined when it lies outside the real workspace.
const toWorkspace = (deps: ToolDeps, real: string, root: string): string | undefined =>
  isInside(root, real) ? resolve(deps.ctx.cwd, relative(root, real)) : undefined

const realOf = (deps: ToolDeps, path: string): Effect.Effect<string | undefined> =>
  probe(deps, ["realpath", "--", path]).pipe(
    Effect.map((r) => (r === undefined || r.exitCode !== 0 ? undefined : lineOf(r.stdout))),
  )

// The path as the Bot's filesystem resolves it (symlinks followed), mapped back under the workspace path the Policy
// and the Tank know. Undefined when it does not exist or resolves outside the workspace. With `allowMissing` the
// deepest existing ancestor is resolved and the missing tail is kept (a file about to be created); `realpath -m` is
// not portable (macOS), so the walk is done here.
const resolveInWorkspace = (
  deps: ToolDeps,
  lexical: string,
  allowMissing: boolean,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const root = yield* realOf(deps, deps.ctx.cwd)
    if (root === undefined) return undefined
    let existing = lexical
    const tail: Array<string> = []
    for (let depth = 0; depth < MAX_WALK; depth++) {
      const real = yield* realOf(deps, existing)
      if (real !== undefined) return toWorkspace(deps, resolve(real, ...tail), root)
      if (!allowMissing || existing === deps.ctx.cwd) return undefined
      tail.unshift(basename(existing))
      existing = dirname(existing)
    }
    return undefined
  })

export const readFileTool = (deps: ToolDeps, raw: string): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    const args = yield* parseArgs(ReadArgs, raw)
    const call: ToolCall = {
      tool: "read_file",
      input: { path: args.path.slice(0, 200) },
      resource: args.path.slice(0, 200),
    }
    if (invalidPath(args.path)) return failed(call, "invalid path")
    const lexical = insideCwd(deps.ctx.cwd, args.path)
    if (lexical === undefined) return failed(call, "path is outside the workspace")
    // Confinement first: nothing below touches a file before it is known to be inside, and the Policy judges the
    // path that will really be read.
    const target = yield* resolveInWorkspace(deps, lexical, false)
    if (target === undefined) return failed(call, NOT_READABLE)
    const verdict = yield* judge(deps, { tool: "Read", input: { file_path: target }, resource: target }, call)
    if (verdict !== undefined) return verdict
    const regular = yield* probe(deps, ["test", "-f", target])
    if (regular === undefined || regular.exitCode !== 0) return failed(call, NOT_READABLE)
    const counted = yield* probe(deps, ["wc", "-c", target])
    const size =
      counted?.exitCode === 0 ? Number.parseInt(counted.stdout.trim().split(/\s+/)[0] ?? "", 10) : Number.NaN
    if (Number.isNaN(size)) return failed(call, NOT_READABLE)
    if (size > FILE_MAX_BYTES) return failed(call, `file is larger than ${FILE_MAX_BYTES} bytes`)
    return yield* deps.tank.readFile(deps.ctx, target).pipe(
      // A file swapped for a FIFO after the checks must not hold the run.
      Effect.timeout(PROBE_TIMEOUT_MS),
      Effect.map(
        (content): ToolOutcome => ({
          kind: "result",
          content: clip(content, READ_OUTPUT_MAX_CHARS),
          events: [{ kind: "tool_call", call, status: "completed" }],
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          failed(call, "_tag" in error && error._tag === "TankError" ? tankMessage(error) : NOT_READABLE),
        ),
      ),
    )
  }).pipe(
    Effect.catch((message: string) =>
      Effect.succeed(failed({ tool: "read_file", input: { path: "" } }, message)),
    ),
  )

export const writeFileTool = (deps: ToolDeps, raw: string): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    const args = yield* parseArgs(WriteArgs, raw)
    const { path, content } = args
    const call: ToolCall = {
      tool: "write_file",
      input: { path: path.slice(0, 200) },
      resource: path.slice(0, 200),
    }
    if (invalidPath(path)) return failed(call, "invalid path")
    const lexical = insideCwd(deps.ctx.cwd, path)
    if (lexical === undefined) return failed(call, "path is outside the workspace")
    if (Buffer.byteLength(content, "utf8") > FILE_MAX_BYTES)
      return failed(call, `content is larger than ${FILE_MAX_BYTES} bytes`)
    // The Policy and the Tank both get the path that will really be written, not the name the model used: a link
    // such as notes.txt -> secret/.env is judged as secret/.env.
    const target = yield* resolveInWorkspace(deps, lexical, true)
    if (target === undefined) return failed(call, "path is outside the workspace")
    const verdict = yield* judge(
      deps,
      { tool: "Write", input: { file_path: target }, resource: target },
      call,
    )
    if (verdict !== undefined) return verdict
    // An existing target must be a regular file: writing into a FIFO or device would block or hit hardware.
    const exists = yield* probe(deps, ["test", "-e", target])
    if (exists === undefined) return failed(call, "could not inspect the target path")
    if (exists.exitCode === 0) {
      const regular = yield* probe(deps, ["test", "-f", target])
      if (regular === undefined || regular.exitCode !== 0) return failed(call, "target is not a regular file")
    }
    return yield* deps.tank.writeFile(deps.ctx, target, content).pipe(
      Effect.map(
        (): ToolOutcome => ({
          kind: "result",
          content: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path.slice(0, 200)}`,
          events: [{ kind: "file_edit", path: target }],
        }),
      ),
      Effect.catch((error) => Effect.succeed(failed(call, tankMessage(error)))),
    )
  }).pipe(
    Effect.catch((message: string) =>
      Effect.succeed(failed({ tool: "write_file", input: { path: "" } }, message)),
    ),
  )
