import type { ExecutorTask, ModelTier, PermissionMode, SessionId } from "@shoalwork/contracts"
import type { Effort } from "../executor.js"

// Sentinel: no `-m` flag, so codex uses the model from the Bot's own config.toml.
export const CODEX_DEFAULT_MODEL = "codex-default"

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access"

export type CodexTarget = { readonly model: string; readonly effort?: Effort }

// Model per tier; a tier without an entry uses the codex default (no -m).
export type CodexModels = Partial<Record<ModelTier, string>>

// Codex has no flag for maxTurns or budget.usd; the executor enforces seconds and tokens itself.
export const makeMapTier =
  (models: CodexModels = {}) =>
  (tier: ModelTier): CodexTarget => ({ model: models[tier] ?? CODEX_DEFAULT_MODEL })

// The task's own model and effort (set by the Lead) win; the tier mapping fills what the task leaves open.
export const targetFor = (task: ExecutorTask, mapTier: (tier: ModelTier) => CodexTarget): CodexTarget => {
  const mapped = mapTier(task.tier)
  const model = task.model ?? mapped.model
  const effort = task.effort ?? mapped.effort
  return effort === undefined ? { model } : { model, effort }
}

export const sandboxFor = (mode: PermissionMode): CodexSandbox => {
  switch (mode) {
    case "readonly":
      return "read-only"
    case "edit":
    case "auto":
      return "workspace-write"
    case "bypass":
      return "danger-full-access"
  }
}

// `--` ends option parsing, so a prompt that starts with "-" is taken as the prompt, not as a flag.
export const buildRunArgs = (task: ExecutorTask, cwd: string, target: CodexTarget): ReadonlyArray<string> => [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "-C",
  cwd,
  ...(target.model === CODEX_DEFAULT_MODEL ? [] : ["-m", target.model]),
  "-s",
  sandboxFor(task.permissionMode),
  "-c",
  "approval_policy=never",
  ...(target.effort === undefined ? [] : ["-c", `model_reasoning_effort=${target.effort}`]),
  "--",
  task.prompt,
]

// Resume refuses to run outside a git repo without --skip-git-repo-check (06-research §1). Without -m the resumed turn
// takes the model of the Bot's config.toml, which a ChatGPT account may refuse, so the tier model is passed the same way as in buildRunArgs.
export const buildResumeArgs = (
  sessionId: SessionId,
  prompt: string,
  target: CodexTarget,
): ReadonlyArray<string> => [
  "exec",
  "resume",
  "--skip-git-repo-check",
  ...(target.model === CODEX_DEFAULT_MODEL ? [] : ["-m", target.model]),
  sessionId,
  "--json",
  "--",
  prompt,
]

// config.toml table of the reef MCP server. The token is named by env_vars, never written into the file.
export const reefTomlBlock = (args: ReadonlyArray<string>, command: string, tokenEnv: string): string =>
  [
    "[mcp_servers.reef]",
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `env_vars = [${JSON.stringify(tokenEnv)}]`,
    "",
  ].join("\n")

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/

const isReefTable = (name: string): boolean => {
  const normalized = name.replace(/["'\s]/g, "")
  return normalized === "mcp_servers.reef" || normalized.startsWith("mcp_servers.reef.")
}

// Replaces every reef table (and its sub-tables) with `block` and keeps all other lines as they are. Running it on
// its own output gives the same text, so repeated runs leave one reef table.
export const mergeMcpTable = (existing: string, block: string): string => {
  const kept: Array<string> = []
  let inReef = false
  for (const line of existing.split("\n")) {
    const header = TABLE_HEADER.exec(line)
    if (header !== null) {
      inReef = isReefTable(header[1] ?? "")
    }
    if (!inReef) {
      kept.push(line)
    }
  }
  const head = kept.join("\n").trimEnd()
  return head === "" ? block : `${head}\n\n${block}`
}
