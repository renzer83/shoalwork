import type { ExecutorTask, ModelTier, PermissionMode } from "@shoalwork/contracts"

export type GeminiTarget = { readonly model: string }

// Model ids are UNVERIFIED (no logged-in Gemini CLI on this machine). config/model-tiers.yaml replaces them (T-026).
export const defaultMapTier = (tier: ModelTier): GeminiTarget => {
  switch (tier) {
    case "chat":
    case "decision":
    case "light":
      return { model: "gemini-flash-latest" }
    case "heavy":
      return { model: "gemini-pro-latest" }
  }
}

export const approvalModeFor = (mode: PermissionMode): "plan" | "auto_edit" | "yolo" => {
  switch (mode) {
    case "readonly":
      return "plan"
    case "edit":
    case "auto":
      return "auto_edit"
    case "bypass":
      return "yolo"
  }
}

// The prompt is bound to --prompt= as one argv element. A separate `-p <prompt>` or a `--` separator would let a
// prompt that starts with "-" reach the option parser (05-conventions §11). Resume uses --resume, not --session-id:
// gemini-cli 0.59.0 refuses --session-id for an existing session ("already exists. Use --resume").
export const buildArgs = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => GeminiTarget,
): ReadonlyArray<string> => {
  const model = task.model ?? mapTier(task.tier).model
  return [
    `--prompt=${task.prompt}`,
    "--output-format",
    "stream-json",
    "--approval-mode",
    approvalModeFor(task.permissionMode),
    "-m",
    model,
    ...(task.resumeSessionId === undefined ? [] : [`--resume=${task.resumeSessionId}`]),
  ]
}
