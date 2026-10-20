import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bot, TaskSpec } from "@shoalwork/contracts"
import { makeTankLocal, type TankShape } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import { stepIdFor } from "../../src/verdict.js"

export const bot = Schema.decodeUnknownSync(Bot)({
  id: "bot_00000000-0000-5000-8000-000000000001",
  name: "dev-demo",
  role: "developer",
  instructions: "Do the work you are given.",
  kind: "auxiliary",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

export const spec = Schema.decodeUnknownSync(TaskSpec)({
  id: "task_00000000-0000-4000-8000-000000000003",
  botId: bot.id,
  title: "Add a feature",
  prompt: "Implement the feature.",
  kind: "code",
  acceptance: ["tests pass"],
  budget: { tokens: 100000, seconds: 60, usd: 1 },
  tier: "light",
  origin: "api",
})

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, stdio: "pipe" })

// A scratch directory for one test, and a repo on branch main with the given files committed.
export const scratchRepo = (
  files: Record<string, string>,
): { readonly dir: string; readonly origin: string } => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-context-"))
  const origin = join(dir, "origin")
  mkdirSync(origin)
  git(origin, "init", "-q", "-b", "main")
  for (const [name, content] of Object.entries({ "README.md": "# demo\n", ...files })) {
    writeFileSync(join(origin, name), content)
  }
  git(origin, "add", "-A")
  git(origin, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init")
  return { dir, origin }
}

export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true })

// The real local Tank over the scratch directory: a worktree of the repo on the Bot's branch for one step.
export const localTank = (dir: string): TankShape =>
  makeTankLocal({ root: join(dir, "tank"), baseEnv: { PATH: process.env.PATH } })

export const prepareWorktree = (tank: TankShape, origin: string, attempt = 1) =>
  tank.prepare(bot, { stepId: stepIdFor(spec.id, attempt), repo: { url: origin, base: "main" } })

export const orDie = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.orDie)
