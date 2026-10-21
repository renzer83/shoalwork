import type { ExecutorTask, ModelTier, PermissionMode } from "@shoalwork/contracts"
import type { Effort } from "../executor.js"

export type OpencodeTarget = { readonly model: string; readonly effort?: Effort }

// One model per tier, all four required: there is no default model, the caller (config/model-tiers.yaml) decides.
export type OpencodeModels = Readonly<Record<ModelTier, string>>

// Permission rules written into opencode.json. `permission` is the key of opencode 1.19.3 (checked against
// `opencode serve` GET /doc); a denied tool is removed from the model's tool list.
export type OpencodePermission = { readonly edit: "deny"; readonly bash: "deny" }

export const makeMapTier =
  (models: OpencodeModels) =>
  (tier: ModelTier): OpencodeTarget => ({ model: models[tier] })

// The task's own model and effort (set by the Lead) win; the tier mapping fills what the task leaves open.
export const targetFor = (
  task: ExecutorTask,
  mapTier: (tier: ModelTier) => OpencodeTarget,
): OpencodeTarget => {
  const mapped = mapTier(task.tier)
  const model = task.model ?? mapped.model
  const effort = task.effort ?? mapped.effort
  return effort === undefined ? { model } : { model, effort }
}

// opencode takes `provider/model`. Anything else is refused before a process is spawned.
const PROVIDER_MODEL = /^[^/\s]+\/[^\s]+$/

export const isProviderModel = (model: string): boolean => PROVIDER_MODEL.test(model)

// `readonly` denies the tools that write files or run commands. Every other mode writes no rule: `--auto` approves
// whatever is not denied, so the run has no per-tool gate beyond the config the Bot already has.
export const permissionFor = (mode: PermissionMode): OpencodePermission | undefined =>
  mode === "readonly" ? { edit: "deny", bash: "deny" } : undefined

// `--auto` is required headless. With `task.resumeSessionId` the run continues that session (-s). `--` ends option
// parsing, so a prompt that starts with "-" is taken as the prompt, not as a flag.
export const buildRunArgs = (
  task: ExecutorTask,
  cwd: string,
  target: OpencodeTarget,
): ReadonlyArray<string> => [
  "run",
  "--format",
  "json",
  "--auto",
  "--dir",
  cwd,
  "-m",
  target.model,
  ...(target.effort === undefined ? [] : ["--variant", target.effort]),
  ...(task.resumeSessionId === undefined ? [] : ["-s", task.resumeSessionId]),
  "--",
  task.prompt,
]
