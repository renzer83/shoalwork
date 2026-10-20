import { isAbsolute, relative, resolve } from "node:path"
import {
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  RequestError,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk"
import type { BotId, TankError } from "@shoalwork/contracts"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import type { AcpPolicy } from "./permissions.js"

// File access for the agent goes through the Tank, which confines it to the run's cwd (lexically and by realpath,
// so a symlink that points out is refused too). Before that, every call is judged by the Policy as Read or Write
// of the path, so an agent cannot reach with fs/* what request_permission would have denied.
export const FS_MAX_BYTES = 2 * 1024 * 1024

export type FsDeps = {
  readonly tank: TankShape
  readonly ctx: TankContext
  readonly botId: BotId
  readonly policy: AcpPolicy
  // A read-only run never writes through the agent either.
  readonly readonly: boolean
}

const refusal = (path: string, error: TankError): RequestError =>
  error.op === "path"
    ? RequestError.invalidParams({ path }, "path is outside the workspace")
    : RequestError.internalError({ path }, "file operation failed")

const requireAbsolute = (path: string): Effect.Effect<void, RequestError> =>
  isAbsolute(path) ? Effect.void : Effect.fail(RequestError.invalidParams({ path }, "path must be absolute"))

const guard = (deps: FsDeps, tool: "Read" | "Write", path: string): Effect.Effect<void, RequestError> =>
  Effect.gen(function* () {
    yield* requireAbsolute(path)
    if (tool === "Write" && deps.readonly) {
      return yield* Effect.fail(RequestError.invalidParams({ path }, "this run is read-only"))
    }
    const decision = yield* deps.policy(
      deps.botId,
      { tool, input: { file_path: path }, resource: path },
      { cwd: deps.ctx.cwd, roots: [deps.ctx.home] },
    )
    if (decision.effect !== "allow") {
      return yield* Effect.fail(RequestError.invalidParams({ path }, `${tool} of this path is not allowed`))
    }
  })

const tooBig = (path: string): RequestError =>
  RequestError.invalidParams({ path }, `file is larger than ${FS_MAX_BYTES} bytes`)

// Size before reading, so a huge file is never loaded. `wc -c` runs as the Bot through the Tank; a path outside the
// cwd is still refused by the read that follows.
const sizeOf = (deps: FsDeps, path: string): Effect.Effect<number, RequestError> =>
  Effect.gen(function* () {
    const rel = relative(deps.ctx.cwd, resolve(path))
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return yield* Effect.fail(RequestError.invalidParams({ path }, "path is outside the workspace"))
    }
    const result = yield* deps.tank
      .exec(deps.ctx, ["wc", "-c", path])
      .pipe(Effect.mapError((error) => refusal(path, error)))
    const bytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10)
    if (result.exitCode !== 0 || Number.isNaN(bytes))
      return yield* Effect.fail(RequestError.resourceNotFound(path))
    return bytes
  })

// `line` is 1-based; `limit` counts lines.
const slice = (
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string => {
  if ((line === undefined || line === null) && (limit === undefined || limit === null)) return content
  const start = Math.max(0, (line ?? 1) - 1)
  const lines = content.split("\n")
  return lines.slice(start, limit === undefined || limit === null ? undefined : start + limit).join("\n")
}

export const readTextFile = (
  deps: FsDeps,
  params: ReadTextFileRequest,
): Effect.Effect<ReadTextFileResponse, RequestError> =>
  Effect.gen(function* () {
    yield* guard(deps, "Read", params.path)
    if ((yield* sizeOf(deps, params.path)) > FS_MAX_BYTES) return yield* Effect.fail(tooBig(params.path))
    const content = yield* deps.tank
      .readFile(deps.ctx, params.path)
      .pipe(Effect.mapError((error) => refusal(params.path, error)))
    return { content: slice(content, params.line, params.limit) }
  })

export const writeTextFile = (
  deps: FsDeps,
  params: WriteTextFileRequest,
): Effect.Effect<Record<string, never>, RequestError> =>
  Effect.gen(function* () {
    yield* guard(deps, "Write", params.path)
    if (Buffer.byteLength(params.content, "utf8") > FS_MAX_BYTES)
      return yield* Effect.fail(tooBig(params.path))
    yield* deps.tank
      .writeFile(deps.ctx, params.path, params.content)
      .pipe(Effect.mapError((error) => refusal(params.path, error)))
    return {}
  })
