import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Data, Effect } from "effect"
import { mergeMcpTable, reefTomlBlock } from "./codex/args.js"
import type { ExecutorContext } from "./executor.js"
import {
  claudeServerEntries,
  codexServerBlock,
  type McpInject,
  stripManagedServers,
  withManagedServers,
} from "./mcp-inject.js"

// The reef MCP server (packages/reef, bin app-reef-mcp) reads its token from this env var. The config files only
// hold the reference `${SHOALWORK_API_TOKEN}`, never the value.
export const MCP_TOKEN_ENV = "SHOALWORK_API_TOKEN"

// Repo and Bot names that reach argv and the config files: no spaces, quotes or shell metacharacters.
export const MCP_NAME_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/

// What the core attaches to a run so that the CLI gets the reef server. All paths are absolute.
export type McpAttachment = {
  // Built entrypoint of the reef MCP server (packages/reef/dist/mcp.js).
  readonly serverEntry: string
  readonly repo: string
  readonly bot: string
  // Origin of the core API, http or https.
  readonly api: string
  // The Bot's own MCP servers (T-083), next to the reef. Names only; the core adds the env values to the run.
  readonly servers?: ReadonlyArray<McpInject>
  // "off": the run has no repo index to search (T-185), so the reef server is left out of the config (and an old reef table
  // is removed from the Codex config.toml). The fields above are still required and checked.
  readonly reef?: "off"
  // Claude Code only (T-055): the permission bridge server joins the same config. Absent: no bridge.
  readonly permissionBridge?: {
    // Built entrypoint (packages/executors/dist/permission-bridge/index.js).
    readonly serverEntry: string
    readonly mode?: "inline" | "resume"
  }
}

export class McpConfigError extends Data.TaggedError("McpConfigError")<{
  readonly executor: string
  readonly reason: string
  readonly cause: unknown
}> {}

const invalid = (executor: string, reason: string): Effect.Effect<never, McpConfigError> =>
  Effect.fail(new McpConfigError({ executor, reason, cause: undefined }))

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

// Rejects attachments the CLI could not use, before anything is written.
export const validateAttachment = (
  executor: string,
  attachment: McpAttachment,
): Effect.Effect<void, McpConfigError> => {
  // Without the reef server (reef "off") its entrypoint, repo and the API origin are not written anywhere.
  const reef = attachment.reef !== "off"
  if (reef && !isAbsolute(attachment.serverEntry))
    return invalid(executor, "serverEntry must be an absolute path")
  if (reef && !MCP_NAME_PATTERN.test(attachment.repo))
    return invalid(executor, "repo has characters outside the allowlist")
  if (!MCP_NAME_PATTERN.test(attachment.bot))
    return invalid(executor, "bot has characters outside the allowlist")
  if ((reef || attachment.permissionBridge !== undefined) && !isHttpUrl(attachment.api))
    return invalid(executor, "api must be an http or https URL")
  if (attachment.permissionBridge !== undefined && !isAbsolute(attachment.permissionBridge.serverEntry))
    return invalid(executor, "permissionBridge.serverEntry must be an absolute path")
  return Effect.void
}

const serverArgs = (attachment: McpAttachment): ReadonlyArray<string> => [
  attachment.serverEntry,
  "--repo",
  attachment.repo,
  "--bot",
  attachment.bot,
  "--api",
  attachment.api,
]

// Claude Code --mcp-config document. `${VAR}` is expanded by the CLI from its own environment at launch.
export const claudeMcpJson = (attachment: McpAttachment): string => {
  const bridge = attachment.permissionBridge
  const env = { [MCP_TOKEN_ENV]: `\${${MCP_TOKEN_ENV}}` }
  return `${JSON.stringify(
    {
      mcpServers: {
        ...claudeServerEntries(attachment.servers ?? []),
        ...(attachment.reef === "off"
          ? {}
          : { reef: { command: "node", args: serverArgs(attachment), env } }),
        ...(bridge === undefined
          ? {}
          : {
              "permission-bridge": {
                command: "node",
                args: [bridge.serverEntry, "--api", attachment.api, "--mode", bridge.mode ?? "inline"],
                env,
              },
            }),
      },
    },
    null,
    2,
  )}\n`
}

const LINK_REFUSED = "link refused"

// Refuses a symlink at `path` (the file or the directory holding it). A missing path is fine: it is created.
export const assertNoLink = async (path: string): Promise<void> => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (isNotFound(cause)) return undefined
    throw cause
  })
  if (info?.isSymbolicLink() === true) throw new Error(LINK_REFUSED)
}

// Writes `content` to `path` without ever following a link: the temporary file is created exclusively (`wx`) next to
// the target and renamed over it, so a link planted at `path` is replaced, not written through. Mode is always 0600.
export const writeSecureFile = async (dir: string, path: string, content: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await assertNoLink(dir)
  await assertNoLink(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw cause
  }
}

const failureReason = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message === LINK_REFUSED ? "refuses to write through a symlink" : fallback

const writeClaudeConfig = (
  ctx: ExecutorContext,
  attachment: McpAttachment,
): Effect.Effect<string, McpConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(ctx.home, "mcp.json")
      await writeSecureFile(ctx.home, path, claudeMcpJson(attachment))
      return path
    },
    catch: (cause) =>
      new McpConfigError({
        executor: "claude-code",
        reason: failureReason(cause, "cannot write mcp.json"),
        cause,
      }),
  })

// Merges the reef table into the config.toml of the Bot's own CODEX_HOME (never the operator's HOME).
const writeCodexConfig = (
  ctx: ExecutorContext,
  attachment: McpAttachment,
): Effect.Effect<string, McpConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const codexHome = ctx.env.CODEX_HOME ?? join(ctx.home, ".codex")
      const path = join(codexHome, "config.toml")
      await mkdir(codexHome, { recursive: true })
      await assertNoLink(codexHome)
      await assertNoLink(path)
      const existing = await readFile(path, "utf8").catch((cause: unknown) => {
        if (isNotFound(cause)) return ""
        throw cause
      })
      const block =
        attachment.reef === "off" ? "" : reefTomlBlock(serverArgs(attachment), "node", MCP_TOKEN_ENV)
      const merged = mergeMcpTable(stripManagedServers(existing), block)
      await writeSecureFile(
        codexHome,
        path,
        withManagedServers(merged, codexServerBlock(attachment.servers ?? [])),
      )
      return path
    },
    catch: (cause) =>
      new McpConfigError({
        executor: "codex",
        reason: failureReason(cause, "cannot write config.toml"),
        cause,
      }),
  })

// A run with no MCP attachment must not inherit the previous run's servers: Codex reads the whole config.toml of the Bot's
// CODEX_HOME, so the managed region and the reef table are removed (revocation and fail-closed would have no effect
// otherwise). Written only when something changed; the rest of the file is the operator's and stays as it is.
export const clearCodexMcp = (ctx: ExecutorContext): Effect.Effect<void, McpConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const codexHome = ctx.env.CODEX_HOME ?? join(ctx.home, ".codex")
      const path = join(codexHome, "config.toml")
      await assertNoLink(codexHome)
      await assertNoLink(path)
      const existing = await readFile(path, "utf8").catch((cause: unknown) => {
        if (isNotFound(cause)) return undefined
        throw cause
      })
      if (existing === undefined) return
      const cleaned = mergeMcpTable(stripManagedServers(existing), "").trimEnd()
      if (cleaned === existing.trimEnd()) return
      await writeSecureFile(codexHome, path, cleaned === "" ? "" : `${cleaned}\n`)
    },
    catch: (cause) =>
      new McpConfigError({
        executor: "codex",
        reason: failureReason(cause, "cannot clear config.toml"),
        cause,
      }),
  })

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

// Writes the MCP config the given CLI needs for this run and returns its path. Requires ctx.mcp.
export const mcpConfigFor = (
  executorId: "claude-code" | "codex",
  ctx: ExecutorContext,
): Effect.Effect<string, McpConfigError> => {
  const attachment = ctx.mcp
  if (attachment === undefined) return invalid(executorId, "no MCP attachment on the run context")
  return validateAttachment(executorId, attachment).pipe(
    Effect.andThen(
      executorId === "claude-code" ? writeClaudeConfig(ctx, attachment) : writeCodexConfig(ctx, attachment),
    ),
  )
}
