import type { ExecutorTask, ModelTier, PermissionMode } from "@shoalwork/contracts"
import type { Effort } from "../executor.js"

export type TierMapping = { readonly model: string; readonly effort?: Effort }

// Abstract permission level -> the CLI's --permission-mode value.
const PERMISSION_FLAG: Record<PermissionMode, string> = {
  readonly: "plan",
  edit: "acceptEdits",
  auto: "auto",
  bypass: "bypassPermissions",
}

// argv only (never a shell string). The prompt is last, after `--`, so text that starts with "-" (which may come
// from a third party) is read as a prompt and never as a flag: `-p "--version"` prints the CLI version.
export const buildArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => TierMapping,
): ReadonlyArray<string> => {
  const { model, effort } = mapTier(task.tier)
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
    "--",
    task.prompt,
  ]
}

// Chat mode (T-017). The alias `haiku` was routed to Sonnet by CLI 2.1.304 (06-research/claude-code.md §10),
// so the full model id is pinned.
export const CHAT_MODEL = "claude-haiku-5-5"

// Without this the CLI loads the claude.ai connectors and plugins: ~145k cache tokens and ~2 s per turn (06-research §10).
const NO_MCP_SERVERS = '{"mcpServers":{}}'

// One turn, no builtin tools, JSON output. The prompt stays last, after `--`, like buildArgs.
export const buildChatArgs = (task: ExecutorTask): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--model",
  CHAT_MODEL,
  "--effort",
  "low",
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
