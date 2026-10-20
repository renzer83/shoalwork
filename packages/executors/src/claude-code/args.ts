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
