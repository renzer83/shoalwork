import type { ExecutorTask, ModelTier, PermissionMode } from "@shoalwork/contracts"
import type { Effort } from "../executor.js"

export type TierMapping = { readonly model: string; readonly effort?: Effort }

// "none": the CLI ignores the claude.ai connectors and plugins of the account (~145k cache tokens per turn otherwise).
// "inherit": no MCP flags; reserved for T-042 (the Bot's own MCP servers).
export type McpMode = "none" | "inherit"

const NO_MCP_ARGS: ReadonlyArray<string> = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']

// Abstract permission level -> the CLI's --permission-mode value.
const PERMISSION_FLAG: Record<PermissionMode, string> = {
  readonly: "plan",
  edit: "acceptEdits",
  auto: "auto",
  bypass: "bypassPermissions",
}

// The task's own model and effort (set by the Lead from the tier table and the Bot override) win; the adapter's
// mapTier fills what the task leaves open.
export const effectiveMapping = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping,
): TierMapping => {
  const mapped = mapTier(task.tier)
  const model = task.model ?? mapped.model
  const effort = task.effort ?? mapped.effort
  return effort === undefined ? { model } : { model, effort }
}

// argv only (never a shell string). The prompt is last, after `--`, so text that starts with "-" (which may come
// from a third party) is read as a prompt and never as a flag: `-p "--version"` prints the CLI version.
export const buildArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping,
  mcp: McpMode = "none",
): ReadonlyArray<string> => {
  const { model, effort } = effectiveMapping(task, mapTier)
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    PERMISSION_FLAG[task.permissionMode],
    "--max-turns",
    String(task.maxTurns),
    "--max-budget-usd",
    task.budget.usd.toFixed(2),
    "--model",
    model,
    ...(effort !== undefined ? ["--effort", effort] : []),
    ...(task.allowedTools.length > 0 ? ["--allowedTools", task.allowedTools.join(",")] : []),
    ...(task.resumeSessionId !== undefined ? ["--resume", task.resumeSessionId] : []),
    ...(task.systemAppend !== undefined ? ["--append-system-prompt", task.systemAppend] : []),
    ...(mcp === "none" ? NO_MCP_ARGS : []),
    "--",
    task.prompt,
  ]
}

// Chat mode (T-017). The alias `haiku` was routed to Sonnet by CLI 2.1.304 (06-research/claude-code.md §10),
// so the full model id is pinned.
export const CHAT_MODEL = "claude-haiku-5-5"

// Without this the CLI loads the claude.ai connectors and plugins: ~145k cache tokens and ~2 s per turn (06-research §10).
const NO_MCP_SERVERS = '{"mcpServers":{}}'

// Default mapping of the chat adapter: every tier it serves (chat, decision) runs CHAT_MODEL at low effort.
// The config file replaces it through the adapter's mapTier option (T-026).
export const defaultChatMapTier = (): TierMapping => ({ model: CHAT_MODEL, effort: "low" })

// One turn, no builtin tools, JSON output. The prompt stays last, after `--`, like buildArgs.
export const buildChatArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping = defaultChatMapTier,
): ReadonlyArray<string> => {
  const { model, effort } = effectiveMapping(task, mapTier)
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    ...(effort !== undefined ? ["--effort", effort] : []),
    "--tools",
    "",
    "--max-turns",
    "1",
    "--permission-mode",
    "plan",
    "--strict-mcp-config",
    "--mcp-config",
    NO_MCP_SERVERS,
    ...(task.resumeSessionId !== undefined ? ["--resume", task.resumeSessionId] : []),
    ...(task.systemAppend !== undefined ? ["--append-system-prompt", task.systemAppend] : []),
    "--",
    task.prompt,
  ]
}

// Warm chat (T-163): one long-lived process per scope. Same flags as the one-shot chat, but messages arrive on stdin
// as stream-json lines, so there is no `--`/prompt in argv and no `--max-turns` (no tools, so a turn is one reply).
// --resume and --append-system-prompt only apply when the process is spawned.
export const buildWarmChatArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping = defaultChatMapTier,
): ReadonlyArray<string> => {
  const { model, effort } = effectiveMapping(task, mapTier)
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(effort !== undefined ? ["--effort", effort] : []),
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--strict-mcp-config",
    "--mcp-config",
    NO_MCP_SERVERS,
    ...(task.resumeSessionId !== undefined ? ["--resume", task.resumeSessionId] : []),
    ...(task.systemAppend !== undefined ? ["--append-system-prompt", task.systemAppend] : []),
  ]
}

// One user turn for the warm process stdin (shape verified on CLI 2.1.304, 06-research/claude-code.md §10).
// U+2028/U+2029 are escaped because JSON.stringify leaves them raw and a line splitter may treat them as breaks.
export const encodeWarmUserMessage = (text: string): string =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: text } })
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}\n`
