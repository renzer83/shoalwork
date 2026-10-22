// What the Configuração screen knows about an executor beyond what GET /executors says: the family it belongs to
// (for the icon and the name) and the models the product ships for it. The core has no models route yet, so this is a
// presentation catalog: it names models, it does not decide which one a task uses (config/model-tiers.yaml does).

export type ExecutorFamily = "claude" | "codex" | "gemini" | "ollama" | "other"

export type ModelTag = "default" | "quality" | "reasoning" | "complex" | "speed" | "simple"

export interface ModelInfo {
  readonly id: string
  readonly label: string
  readonly tags: ReadonlyArray<ModelTag>
}

const CLAUDE_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tags: ["default", "quality"] },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", tags: ["reasoning", "complex"] },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tags: ["speed", "simple"] },
]

const CODEX_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "gpt-5", label: "GPT-5", tags: ["default", "quality"] },
  { id: "gpt-5-mini", label: "GPT-5 mini", tags: ["speed", "simple"] },
  { id: "o3", label: "o3", tags: ["reasoning", "complex"] },
]

const GEMINI_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "gemini-pro-latest", label: "Gemini Pro", tags: ["default", "quality"] },
  { id: "gemini-flash-latest", label: "Gemini Flash", tags: ["speed", "simple"] },
]

const OLLAMA_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "qwen3:8b", label: "qwen3:8b", tags: ["default"] },
  { id: "qwen3:4b", label: "qwen3:4b", tags: ["speed", "simple"] },
]

const MODELS: Readonly<Record<ExecutorFamily, ReadonlyArray<ModelInfo>>> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
  ollama: OLLAMA_MODELS,
  other: [],
}

// Ids are "<kind>" or "<kind>@<instance>" (contracts ExecutorId). An instance on the local Ollama endpoint is an
// Ollama executor whatever CLI drives it.
export const familyOf = (id: string): ExecutorFamily => {
  const [kind = "", instance] = id.split("@")
  if (instance === "ollama" || kind === "ollama") return "ollama"
  if (kind === "claude-code") return "claude"
  if (kind === "codex") return "codex"
  if (kind === "gemini") return "gemini"
  return "other"
}

const BASE_NAME: Readonly<Record<ExecutorFamily, string>> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  gemini: "Google Gemini CLI",
  ollama: "Ollama (Local)",
  other: "",
}

// "Claude CLI", "Claude CLI · zai": the instance after "@" tells two executors of one CLI apart.
export const executorName = (id: string): string => {
  const family = familyOf(id)
  const [kind = id, instance] = id.split("@")
  const base = BASE_NAME[family] === "" ? kind : BASE_NAME[family]
  if (family === "ollama" && instance === "ollama") {
    return kind === "ollama" ? base : `${kind} · ollama`
  }
  return instance === undefined ? base : `${base} · ${instance}`
}

export const modelsOf = (id: string): ReadonlyArray<ModelInfo> => MODELS[familyOf(id)]

// The model an executor starts with: the one tagged default, else the first.
export const defaultModelOf = (id: string): ModelInfo | undefined => {
  const models = modelsOf(id)
  return models.find((model) => model.tags.includes("default")) ?? models[0]
}

export const modelLabel = (executor: string, model: string): string =>
  modelsOf(executor).find((entry) => entry.id === model)?.label ?? model

// USD per 1K tokens, only where the figure is a fact of the setup (a local model costs nothing).
export const costPer1kOf = (id: string): number | undefined => (familyOf(id) === "ollama" ? 0 : undefined)
