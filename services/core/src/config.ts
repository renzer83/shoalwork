import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_AGENT_MSGS_PER_TASK } from "@shoalwork/lead"
import { Config, Option, Redacted, Schema } from "effect"

// The one rule for every setting: unset and blank (`NAME=` in .env, .env.example) both take the default.
// `read` parses the value only when it is not blank, so a blank Int or Literal never reaches the parser.
export const setting = <A>(
  name: string,
  read: (name: string) => Config.Config<A>,
  fallback: A,
): Config.Config<A> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.flatMap((value) => (value.trim() === "" ? Config.succeed(fallback) : read(name))),
  )

// Same blank rule for settings that are simply absent when blank (Telegram off, GitHub webhook 503).
export const optionalSetting = <A>(
  name: string,
  read: (name: string) => Config.Config<A>,
): Config.Config<Option.Option<A>> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.flatMap((value) =>
      value.trim() === "" ? Config.succeed(Option.none<A>()) : read(name).pipe(Config.map(Option.some)),
    ),
  )

// src/ and dist/ sit at the same depth, so the same relative path reaches the repo root from both.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

// Relative paths (DATABASE_PATH, TANK_ROOT, bots dir) are anchored to the repo root, not the cwd (pnpm --filter runs from services/core).
export const resolveRepoPath = (configured: string, root: string = REPO_ROOT): string =>
  resolve(root, configured)

export const resolveDatabasePath = (configured: string, root: string = REPO_ROOT): string =>
  resolveRepoPath(configured, root)

// Read once from package.json so /health and the CLI share one version source.
const PackageManifest = Schema.Struct({ version: Schema.String })
const manifestRaw: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
export const APP_VERSION: string = Schema.decodeUnknownSync(PackageManifest)(manifestRaw).version

// Snapshot of the host env, taken when called (after .env is loaded). Only the Bot allowlist in the Tank reads it.
export const hostEnvSnapshot = (): Readonly<Record<string, string | undefined>> => ({ ...process.env })

// Origin the Bot's reef MCP server calls: APP_URL when set, else the loopback address of this core (T-168).
export const coreApiOrigin = (appUrl: string, port: number): string =>
  appUrl.trim() === "" ? `http://127.0.0.1:${port}` : appUrl.trim()

// Built entrypoint of the reef MCP server: REEF_MCP_ENTRY when set (relative paths anchor to the repo root), else the
// default build output of packages/reef (T-168).
export const reefMcpEntryFrom = (configured: string): string =>
  resolveRepoPath(configured.trim() === "" ? "packages/reef/dist/mcp.js" : configured.trim())

// Built entrypoint of the permission bridge server: PERMISSION_BRIDGE_ENTRY when set (relative paths anchor to the
// repo root), else the default build output of packages/executors (T-177).
export const permissionBridgeEntryFrom = (configured: string): string =>
  resolveRepoPath(
    configured.trim() === "" ? "packages/executors/dist/permission-bridge/index.js" : configured.trim(),
  )

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const

export const AppConfig = Config.all({
  port: setting("PORT", Config.Int, 28900),
  // Fail-closed: the core does not start without a token. Unset and blank both fail with the variable name in the error.
  apiToken: Config.schema(
    Schema.String.pipe(
      Schema.check(Schema.makeFilter((value) => value.trim() !== "" || "API_TOKEN must not be blank")),
    ),
    "API_TOKEN",
  ).pipe(Config.map((value) => Redacted.make(value))),
  databasePath: setting("DATABASE_PATH", Config.String, "./data/shoalwork.db").pipe(
    Config.map((configured) => resolveDatabasePath(configured)),
  ),
  logLevel: setting<(typeof LOG_LEVELS)[number]>(
    "LOG_LEVEL",
    (name) => Config.Literals(LOG_LEVELS, name),
    "info",
  ),
  tankRoot: setting("TANK_ROOT", Config.String, "data/tank").pipe(
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // Only "1" turns on server mode (sudo to the Bot users); anything else is local mode.
  tankSudo: setting("TANK_SUDO", Config.String, "").pipe(Config.map((value) => value === "1")),
  // Codex quota is a local fixed-window counter. These defaults are provisional until T-026 sets real limits.
  codexQuotaWindowSeconds: setting("CODEX_QUOTA_WINDOW_SECONDS", Config.Int, 18000),
  codexQuotaSoftLimitTokens: setting("CODEX_QUOTA_SOFT_LIMIT_TOKENS", Config.Int, 5000000),
  // Until T-026 the same model serves all four codex tiers; blank means codex keeps its own default.
  codexModel: setting("CODEX_MODEL", Config.String, "").pipe(
    Config.map((value) => (value.trim() === "" ? undefined : value.trim())),
  ),
  // Watchdog (T-030): a running task silent this long is stale; a Tank process alive this long is killed.
  watchdogStaleMinutes: setting("WATCHDOG_STALE_MINUTES", Config.Int, 20),
  watchdogMaxProcessMinutes: setting("WATCHDOG_MAX_PROCESS_MINUTES", Config.Int, 45),
  // Budget (T-029): a Bot's usage counts against its budget over this rolling window of hours.
  // How long a request for approval waits for a person before it is denied by default (T-054).
  approvalTtlMinutes: setting("APPROVAL_TTL_MINUTES", Config.Int, 120).pipe(
    Config.map((value) => Math.max(1, value)),
  ),
  budgetBotWindowHours: setting("BUDGET_BOT_WINDOW_HOURS", Config.Int, 24),
  // Plan dispatch (T-050): how many steps of one plan level run at once (default 3; blank takes the default).
  planConcurrency: setting("PLAN_CONCURRENCY", Config.Int, 3).pipe(Config.map((value) => Math.max(1, value))),
  // Agent messages a task may carry before further handoffs are refused (T-046, T-172). A whole number of at least 1;
  // blank takes the Lead's default.
  maxAgentMsgsPerTask: setting(
    "MAX_AGENT_MSGS_PER_TASK",
    (name) => Config.schema(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))), name),
    MAX_AGENT_MSGS_PER_TASK,
  ),
  // Telegram (T-024): the connector starts only when a token is set. A blank value counts as unset (.env.example).
  telegramBotToken: optionalSetting("TELEGRAM_BOT_TOKEN", Config.Redacted),
  telegramAllowedUserIds: setting("TELEGRAM_ALLOWED_USER_IDS", Config.String, ""),
  telegramForumChatId: setting("TELEGRAM_FORUM_CHAT_ID", Config.String, ""),
  // Reflex rules and thresholds (T-023). Relative paths resolve against the repo root.
  reflexConfigPath: setting("REFLEX_CONFIG_PATH", Config.String, "config/reflex.config.yaml").pipe(
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // Embeddings for the Reef (T-034). Nothing connects until a memory is saved or searched.
  ollamaUrl: setting("OLLAMA_URL", Config.String, "http://127.0.0.1:11434").pipe(
    Config.map((value) => value.trim()),
  ),
  ollamaEmbedModel: setting("OLLAMA_EMBED_MODEL", Config.String, "bge-m3").pipe(
    Config.map((value) => value.trim()),
  ),
  // Reef MCP server (T-168): the core origin the Bot's server calls (blank: loopback on PORT) and the built entrypoint.
  appUrl: setting("APP_URL", Config.String, ""),
  reefMcpEntry: setting("REEF_MCP_ENTRY", Config.String, "").pipe(Config.map(reefMcpEntryFrom)),
  // Permission bridge (T-177): off until the LIVE probe (T-166) passes. On, a claude-code run asks the Policy of the
  // product through the bridge server instead of a static permission mode; blank counts as off.
  permissionBridge: setting("PERMISSION_BRIDGE", Config.Boolean, false),
  permissionBridgeEntry: setting("PERMISSION_BRIDGE_ENTRY", Config.String, "").pipe(
    Config.map(permissionBridgeEntryFrom),
  ),
  // Policy files, one `<name>.yaml` per policy (T-053). Relative paths resolve against the repo root.
  policyDir: setting("POLICY_DIR", Config.String, "config/policies").pipe(
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // Briefing context budgets (T-041). Relative paths resolve against the repo root.
  contextConfigPath: setting("CONTEXT_CONFIG_PATH", Config.String, "config/context.yaml").pipe(
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // GitHub webhook (T-045): the route answers 503 until a secret is set. A blank value counts as unset.
  githubWebhookSecret: setting("GITHUB_WEBHOOK_SECRET", Config.String, "").pipe(
    Config.map((value) => (value.trim() === "" ? undefined : Redacted.make(value.trim()))),
  ),
  // Model tier table (T-164). Relative paths resolve against the repo root.
  modelTiersPath: setting("MODEL_TIERS_PATH", Config.String, "config/model-tiers.yaml").pipe(
    Config.map((configured) => resolveRepoPath(configured)),
  ),
})

export type AppConfigShape = Config.Success<typeof AppConfig>
