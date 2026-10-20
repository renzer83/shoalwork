import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bot, newStepId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { afterAll } from "vitest"

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

export const gitEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, ...GIT_IDENTITY }
}

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" })

// Temp directory removed after the calling test file finishes. Path is realpath'd (macOS /var -> /private/var).
export const tempDir = (prefix = "tank-test-"): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Bare origin with one commit on `main`. Returns its path; `pushCommit` adds more commits to it.
export const makeOrigin = (root: string): { origin: string; pushCommit: (file: string) => void } => {
  const origin = join(root, "origin.git")
  const seed = join(root, "seed")
  mkdirSync(seed, { recursive: true })
  git(root, "init", "--bare", "-b", "main", origin)
  git(seed, "init", "-b", "main")
  git(seed, "remote", "add", "origin", origin)
  const pushCommit = (file: string) => {
    writeFileSync(join(seed, file), `${file}\n`)
    git(seed, "add", file)
    git(seed, "commit", "-m", `add ${file}`)
    git(seed, "push", "origin", "main")
  }
  pushCommit("README.txt")
  return { origin, pushCommit }
}

export const makeBot = (name = "alice"): Bot =>
  Schema.decodeUnknownSync(Bot)({
    id: `bot_${crypto.randomUUID()}`,
    name,
    role: "dev",
    instructions: "build things",
    kind: "fixed",
    executors: { preferred: "claude-code", allowed: ["claude-code"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 1000, seconds: 60, usd: 1 },
    policy: "default",
    tank: { mode: "local", host: "localhost" },
    memory: { scope: "bot" },
  })

export const stepId = newStepId

export const psCommands = (): string => execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
