import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Shared by the two live tests (LIVE=1 only): the real CLI of the current user, an allow-list env, a built dist/.
export const live = process.env.LIVE === "1"
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
export const distDir = join(packageRoot, "dist", "permission-bridge")

const ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const

export const liveEnv = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

export const buildPackage = (): void => {
  execFileSync(
    process.execPath,
    [
      join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc"),
      "-p",
      packageRoot,
    ],
    {
      stdio: "pipe",
    },
  )
}

export const cliVersion = (): string =>
  execFileSync("claude", ["--version"], { env: liveEnv(), encoding: "utf8" }).trim().split(" ")[0] ??
  "unknown"
