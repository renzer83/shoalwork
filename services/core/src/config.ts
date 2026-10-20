import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Schema } from "effect"

// src/ and dist/ sit at the same depth, so the same relative path reaches the repo root from both.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

// Relative DATABASE_PATH is anchored to the repo root, not the cwd (pnpm --filter runs from services/core).
export const resolveDatabasePath = (configured: string, root: string = REPO_ROOT): string =>
  resolve(root, configured)

// Read once from package.json so /health and the CLI share one version source.
const PackageManifest = Schema.Struct({ version: Schema.String })
const manifestRaw: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
export const APP_VERSION: string = Schema.decodeUnknownSync(PackageManifest)(manifestRaw).version

export const AppConfig = Config.all({
  port: Config.Int("PORT").pipe(Config.withDefault(28900)),
  apiToken: Config.Redacted("API_TOKEN"),
  databasePath: Config.String("DATABASE_PATH").pipe(
    Config.withDefault("./data/shoalwork.db"),
    Config.map((configured) => resolveDatabasePath(configured)),
  ),
  logLevel: Config.Literals(["debug", "info", "warn", "error"], "LOG_LEVEL").pipe(Config.withDefault("info")),
  tankRoot: Config.String("TANK_ROOT").pipe(Config.withDefault(`${homedir()}/.shoalwork/tanks`)),
})
