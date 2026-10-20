import type { ExecutorTask, ModelTier, PermissionMode } from "@shoalwork/contracts"
import type { Effort } from "../executor.js"

export type TierMapping = { readonly model: string; readonly effort?: Effort }

// "none": the CLI ignores the claude.ai connectors and plugins of the account (~145k cache tokens per turn otherwise).
// "inherit": no MCP flags, the CLI loads the account's own servers.
export type McpMode = "none" | "inherit"

const NO_MCP_ARGS: ReadonlyArray<string> = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']

// A run with an attached MCP config (T-042) gets only that config: the account's servers stay out.
const mcpArgs = (mcp: McpMode, mcpConfigFile: string | undefined): ReadonlyArray<string> => {
  if (mcpConfigFile !== undefined) return ["--strict-mcp-config", "--mcp-config", mcpConfigFile]
  return mcp === "none" ? NO_MCP_ARGS : []
}

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

// The reef tools a run with an attached MCP config may call. Added to the task's own list, without duplicates.
export const REEF_MCP_TOOLS: ReadonlyArray<string> = [
  "mcp__reef__search_code",
  "mcp__reef__search_memory",
  "mcp__reef__read_chunk",
]

const allowedToolsArgs = (
  allowedTools: ReadonlyArray<string>,
  mcpConfigFile: string | undefined,
): ReadonlyArray<string> => {
  const tools = mcpConfigFile === undefined ? allowedTools : [...allowedTools, ...REEF_MCP_TOOLS]
  const unique = [...new Set(tools)]
  return unique.length > 0 ? ["--allowedTools", unique.join(",")] : []
}

// T-055: the CLI asks the product's Policy through the permission-bridge MCP server instead of auto-deciding.
// Needs the run's MCP config file (the bridge server lives in it), so it is off without one.
export const PERMISSION_PROMPT_TOOL = "mcp__permission-bridge__approve"

const usesBridge = (task: ExecutorTask, mcpConfigFile: string | undefined, bridge: boolean): boolean =>
  bridge && mcpConfigFile !== undefined && task.permissionMode === "auto"

// argv only (never a shell string). The prompt is last, after `--`, so text that starts with "-" (which may come
// from a third party) is read as a prompt and never as a flag: `-p "--version"` prints the CLI version.
export const buildArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping,
  mcp: McpMode = "none",
  mcpConfigFile?: string,
  permissionBridge = false,
): ReadonlyArray<string> => {
  const { model, effort } = effectiveMapping(task, mapTier)
  const bridged = usesBridge(task, mcpConfigFile, permissionBridge)
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    bridged ? "default" : PERMISSION_FLAG[task.permissionMode],
    ...(bridged ? ["--permission-prompt-tool", PERMISSION_PROMPT_TOOL] : []),
    "--max-turns",
    String(task.maxTurns),
    "--max-budget-usd",
    task.budget.usd.toFixed(2),
    "--model",
    model,
    ...(effort !== undefined ? ["--effort", effort] : []),
    ...allowedToolsArgs(task.allowedTools, mcpConfigFile),
    ...(task.resumeSessionId !== undefined ? ["--resume", task.resumeSessionId] : []),
    ...(task.systemAppend !== undefined ? ["--append-system-prompt", task.systemAppend] : []),
    ...mcpArgs(mcp, mcpConfigFile),
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
