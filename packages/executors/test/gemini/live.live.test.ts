import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorEvent, type ExecutorTask, TaskId } from "@shoalwork/contracts"
import { spawnProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeGemini } from "../../src/gemini/index.js"

// Real gemini CLI, real network, logged-in account: runs only with LIVE=1. Opens a login page when not logged in.
describe.skipIf(process.env.LIVE !== "1")("gemini live", () => {
  it.live("answers pong through the real gemini CLI", () =>
    Effect.gen(function* () {
      const cwd = mkdtempSync(join(tmpdir(), "gemini-live-"))
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
      const ctx: TankContext = {
        botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000003"),
        botName: "live",
        cwd,
        home: env.HOME ?? cwd,
        env,
      }
      const tank: TankShape = {
        mode: "local",
        prepare: () => Effect.die("unused"),
        exec: () => Effect.die("unused"),
        spawnStream: (spawnCtx, cmd) => spawnProcess(cmd, { cwd: spawnCtx.cwd, env: spawnCtx.env }),
        readFile: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        writeHomeFile: () => Effect.die("unused"),
        worktrees: () => Effect.die("unused"),
        removeWorktree: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
      }
      const task: ExecutorTask = {
        taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000004"),
        botId: ctx.botId,
        prompt: "Reply with exactly one word: pong",
        tier: "chat",
        allowedTools: [],
        permissionMode: "readonly",
        maxTurns: 1,
        budget: { tokens: 200_000, seconds: 240, usd: 1 },
      }
      const events: ReadonlyArray<ExecutorEvent> = yield* Stream.runCollect(makeGemini().run(task, ctx)).pipe(
        Effect.scoped,
        Effect.provideService(Tank, tank),
        Effect.ensuring(Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))),
      )
      const last = events.at(-1)
      expect(last).toMatchObject({ kind: "done" })
      expect(last?.kind === "done" && last.result.toLowerCase()).toContain("pong")
    }),
  )
})
