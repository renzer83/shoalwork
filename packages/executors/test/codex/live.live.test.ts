import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorEvent, type ExecutorTask, TaskId } from "@shoalwork/contracts"
import { spawnProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeCodexExecutor } from "../../src/codex/index.js"

// Real codex CLI, real network, logged-in account: runs only with LIVE=1.
describe.skipIf(process.env.LIVE !== "1")("codex live", () => {
  it.live("answers pong through the real codex CLI", () =>
    Effect.gen(function* () {
      // The model is set per tier, because the codex default in config.toml may be refused by the account.
      const liveModel = process.env.CODEX_LIVE_MODEL ?? "gpt-5.6-luna"
      const cwd = mkdtempSync(join(tmpdir(), "codex-live-"))
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
      const executor = makeCodexExecutor({
        quotaWindowSeconds: 3600,
        quotaSoftLimitTokens: 1_000_000,
        models: { chat: liveModel, decision: liveModel, light: liveModel, heavy: liveModel },
      })
      const events: ReadonlyArray<ExecutorEvent> = yield* Stream.runCollect(executor.run(task, ctx)).pipe(
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
