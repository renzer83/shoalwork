import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorEvent, ExecutorId, type ExecutorTask, TaskId } from "@shoalwork/contracts"
import { spawnProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeAcp } from "../../src/acp/index.js"

// Real ACP agent, real network, logged-in account: runs only with LIVE=1. Defaults to `opencode acp`;
// ACP_LIVE_BIN / ACP_LIVE_ARGS (space separated) point it at another one, e.g. `gemini --acp`.
const LIVE_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]
const BIN = process.env.ACP_LIVE_BIN ?? "opencode"
const ARGS = (process.env.ACP_LIVE_ARGS ?? "acp").split(" ").filter((arg) => arg !== "")

describe.skipIf(process.env.LIVE !== "1")(`acp live (${BIN} ${ARGS.join(" ")})`, () => {
  it.live(
    "answers pong through the real agent",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "acp-live-"))
        // Only what the CLI needs to find its login; nothing else of this shell reaches the agent.
        const env: Record<string, string> = {}
        for (const key of LIVE_ENV) {
          const value = process.env[key]
          if (value !== undefined) env[key] = value
        }
        const ctx: TankContext = {
          botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000003"),
          botName: "live",
          cwd,
          home: env.HOME ?? cwd,
          env,
        }
        const unused = () => Effect.die("unused")
        const tank: TankShape = {
          mode: "local",
          prepare: unused,
          exec: unused,
          spawnStream: (spawnCtx, cmd) => spawnProcess(cmd, { cwd: spawnCtx.cwd, env: spawnCtx.env }),
          readFile: unused,
          writeFile: unused,
          writeHomeFile: unused,
          worktrees: unused,
          removeWorktree: unused,
          release: unused,
        }
        const task: ExecutorTask = {
          taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000004"),
          botId: ctx.botId,
          prompt: "Reply with exactly one word: pong",
          tier: "chat",
          allowedTools: [],
          permissionMode: "readonly",
          maxTurns: 1,
          budget: { tokens: 200_000, seconds: 90, usd: 1 },
        }
        const executor = makeAcp({
          id: Schema.decodeUnknownSync(ExecutorId)("acp-live"),
          bin: BIN,
          args: ARGS,
          // Nothing is allowed: a plain answer needs no tool.
          policy: () => Effect.succeed({ effect: "deny", risk: "read" }),
          quotaWindowSeconds: 3600,
          quotaSoftLimitTokens: 1_000_000,
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
    120_000,
  )
})
