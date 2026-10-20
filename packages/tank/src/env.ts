import { join } from "node:path"

// Environment inherited by Bot processes; the caller (core) decides, this package never reads process.env.
export type BaseEnv = Readonly<Record<string, string | undefined>>

// The only keys a Bot process inherits from the core's base env. Everything else is dropped (R7, ADR-011).
const INHERITED_ENV_KEYS: ReadonlyArray<string> = [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]

// Bots never get an API key from the core, even when extraEnv asks for one.
const DROPPED_EXTRA_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"])

// Keys one execution (step) may receive, e.g. its MCP token (T-167). Anything else is refused by prepare.
export const STEP_ENV_PATTERN = /^SHOALWORK_[A-Z0-9_]+$/

// Env a Bot process receives: an allowlist of the base env, then extraEnv (minus dropped keys), then the keys the
// Tank always owns (Bot home, CLI config dirs, git safety defaults). Tank keys win over extraEnv.
export const buildBotEnv = (
  baseEnv: BaseEnv,
  home: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = baseEnv[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!DROPPED_EXTRA_KEYS.has(key)) env[key] = value
  }
  env.HOME = home
  env.CLAUDE_CONFIG_DIR = join(home, ".claude")
  env.CODEX_HOME = join(home, ".codex")
  env.GEMINI_CLI_HOME = home
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_ALLOW_PROTOCOL = "file:git:http:https:ssh"
  return env
}
