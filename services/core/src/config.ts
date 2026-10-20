import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Redacted, Schema } from "effect"

const orDefault = (fallback: string) => (value: string) => (value.trim() === "" ? fallback : value.trim())

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

export const AppConfig = Config.all({
  port: Config.Int("PORT").pipe(Config.withDefault(28900)),
  apiToken: Config.Redacted("API_TOKEN"),
  databasePath: Config.String("DATABASE_PATH").pipe(
    Config.withDefault("./data/shoalwork.db"),
    Config.map((configured) => resolveDatabasePath(configured)),
  ),
  logLevel: Config.Literals(["debug", "info", "warn", "error"], "LOG_LEVEL").pipe(Config.withDefault("info")),
  tankRoot: Config.String("TANK_ROOT").pipe(
    Config.withDefault("data/tank"),
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // Only "1" turns on server mode (sudo to the Bot users); anything else is local mode.
  tankSudo: Config.String("TANK_SUDO").pipe(
    Config.withDefault(""),
    Config.map((value) => value === "1"),
  ),
  // Codex quota is a local fixed-window counter. These defaults are provisional until T-026 sets real limits.
  codexQuotaWindowSeconds: Config.Int("CODEX_QUOTA_WINDOW_SECONDS").pipe(Config.withDefault(18000)),
  codexQuotaSoftLimitTokens: Config.Int("CODEX_QUOTA_SOFT_LIMIT_TOKENS").pipe(Config.withDefault(5000000)),
  // Until T-026 the same model serves all four codex tiers; blank means codex keeps its own default.
  codexModel: Config.String("CODEX_MODEL").pipe(
    Config.withDefault(""),
    Config.map((value) => (value.trim() === "" ? undefined : value.trim())),
  ),
  // Watchdog (T-030): a running task silent this long is stale; a Tank process alive this long is killed.
  watchdogStaleMinutes: Config.Int("WATCHDOG_STALE_MINUTES").pipe(Config.withDefault(20)),
  watchdogMaxProcessMinutes: Config.Int("WATCHDOG_MAX_PROCESS_MINUTES").pipe(Config.withDefault(45)),
  // Budget (T-029): a Bot's usage counts against its budget over this rolling window of hours.
  budgetBotWindowHours: Config.Int("BUDGET_BOT_WINDOW_HOURS").pipe(Config.withDefault(24)),
  // Telegram (T-024): the connector starts only when a token is set. A blank value counts as unset (.env.example).
  telegramBotToken: Config.Redacted("TELEGRAM_BOT_TOKEN").pipe(Config.option),
  telegramAllowedUserIds: Config.String("TELEGRAM_ALLOWED_USER_IDS").pipe(Config.withDefault("")),
  telegramForumChatId: Config.String("TELEGRAM_FORUM_CHAT_ID").pipe(Config.withDefault("")),
  // Reflex rules and thresholds (T-023). Relative paths resolve against the repo root.
  reflexConfigPath: Config.String("REFLEX_CONFIG_PATH").pipe(
    Config.withDefault("config/reflex.config.yaml"),
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // Embeddings for the Reef (T-034). Nothing connects until a memory is saved or searched.
  ollamaUrl: Config.String("OLLAMA_URL").pipe(
    Config.withDefault(""),
    Config.map(orDefault("http://127.0.0.1:11434")),
  ),
  ollamaEmbedModel: Config.String("OLLAMA_EMBED_MODEL").pipe(
    Config.withDefault(""),
    Config.map(orDefault("bge-m3")),
  ),
  // Reef MCP server (T-168): the core origin the Bot's server calls (blank: loopback on PORT) and the built entrypoint.
  appUrl: Config.String("APP_URL").pipe(Config.withDefault("")),
  reefMcpEntry: Config.String("REEF_MCP_ENTRY").pipe(Config.withDefault(""), Config.map(reefMcpEntryFrom)),
  // Briefing context budgets (T-041). Relative paths resolve against the repo root.
  contextConfigPath: Config.String("CONTEXT_CONFIG_PATH").pipe(
    Config.withDefault("config/context.yaml"),
    Config.map((configured) => resolveRepoPath(configured)),
  ),
  // GitHub webhook (T-045): the route answers 503 until a secret is set. A blank value counts as unset.
  githubWebhookSecret: Config.String("GITHUB_WEBHOOK_SECRET").pipe(
    Config.withDefault(""),
    Config.map((value) => (value.trim() === "" ? undefined : Redacted.make(value.trim()))),
  ),
  // Model tier table (T-164). Relative paths resolve against the repo root.
  modelTiersPath: Config.String("MODEL_TIERS_PATH").pipe(
    Config.withDefault("config/model-tiers.yaml"),
    Config.map((configured) => resolveRepoPath(configured)),
  ),
})

export type AppConfigShape = Config.Success<typeof AppConfig>
