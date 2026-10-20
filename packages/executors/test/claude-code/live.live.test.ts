import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorEvent, ExecutorTask as ExecutorTaskSchema } from "@shoalwork/contracts"
import { spawnProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeClaudeCode } from "../../src/claude-code/index.js"

// Real CLI, real account: runs only with LIVE=1. Uses the logged-in CLI of the current user.
const live = process.env.LIVE === "1"

const liveTank: TankShape = {
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: (ctx, cmd) => spawnProcess(cmd, { cwd: ctx.cwd, env: ctx.env }),
  readFile: () => Effect.die("tank not used by this test"),
  writeFile: () => Effect.die("tank not used by this test"),
  writeHomeFile: () => Effect.die("tank not used by this test"),
  worktrees: () => Effect.die("tank not used by this test"),
  removeWorktree: () => Effect.die("tank not used by this test"),
  release: () => Effect.die("tank not used by this test"),
}

const LIVE_ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const

const liveEnv = (fallbackHome: string): Record<string, string> => {
  const env: Record<string, string> = { HOME: fallbackHome }
  for (const key of LIVE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

describe.skipIf(!live)("claude-code live", () => {
  it.live(
    "runs a real 'pong' prompt and ends with done containing pong",
    () =>
      Effect.gen(function* () {
        const workdir = mkdtempSync(join(tmpdir(), "claude-live-"))
        try {
          // Allow-list env: the CLI finds the macOS login through USER/HOME; no API key or session token is copied.
          const ctx: TankContext = {
            botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000000"),
            botName: "live",
            cwd: workdir,
            home: process.env.HOME ?? workdir,
            env: liveEnv(workdir),
          }
          const task = Schema.decodeUnknownSync(ExecutorTaskSchema)({
            taskId: "task_00000000-0000-4000-8000-000000000001",
            botId: ctx.botId,
            prompt: "reply with the single word pong",
            tier: "chat",
            allowedTools: [],
            permissionMode: "readonly",
            maxTurns: 1,
            budget: { tokens: 20000, seconds: 120, usd: 0.5 },
          })
          const events: ReadonlyArray<ExecutorEvent> = yield* Stream.runCollect(
            makeClaudeCode().run(task, ctx),
          ).pipe(Effect.scoped, Effect.provideService(Tank, liveTank))
          const last = events.at(-1)
          expect(last?.kind).toBe("done")
          expect(last?.kind === "done" ? last.result.toLowerCase() : "").toContain("pong")
        } finally {
          rmSync(workdir, { recursive: true, force: true })
        }
      }),
    // A cold CLI start takes several seconds; the default 5 s timeout is too tight for a real call.
    60_000,
  )
})
