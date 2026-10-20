// ADR-011: no claude-code adapter runs on an API key. Shared by the one-shot and the chat adapters.
const FORBIDDEN_ENV_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"])

// ANTHROPIC_AUTH_TOKEN stays allowed in overrides: it is how gateways such as Z.ai are reached.
export const dropApiKey = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !FORBIDDEN_ENV_KEYS.has(key)))
