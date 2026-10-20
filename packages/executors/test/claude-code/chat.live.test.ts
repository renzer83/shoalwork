import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { spawnProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeClaudeCodeChat, runChatTurn } from "../../src/claude-code/chat.js"
import { type ChatSessions, ChatSessionsLive } from "../../src/claude-code/sessions.js"

// Real CLI, real account: runs only with LIVE=1. Uses the logged-in CLI of the current user (ADR-011).
const live = process.env.LIVE === "1"

const LIVE_ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const

const liveEnv = (fallbackHome: string): Record<string, string> => {
  const env: Record<string, string> = { HOME: fallbackHome }
  for (const key of LIVE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

const chatTask = (): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "reply with the single word pong",
    tier: "chat",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 1,
    budget: { tokens: 20000, seconds: 60, usd: 0.5 },
  })

const cacheOf = (events: ReadonlyArray<ExecutorEvent>): string => {
  const usage = events.find((event) => event.kind === "usage")
  return usage?.kind === "usage"
    ? `cache_write=${usage.usage.cacheWrite} cache_read=${usage.usage.cacheRead}`
    : "no usage event"
}

describe.skipIf(!live)("claude-code chat live", () => {
  it.live(
    "answers pong through the logged-in CLI and resumes the topic session on the second message",
    () =>
      Effect.gen(function* () {
        const workdir = mkdtempSync(join(tmpdir(), "claude-chat-live-"))
        const spawned: Array<ReadonlyArray<string>> = []
        const recordingTank: TankShape = {
          mode: "local",
          prepare: () => Effect.die("tank not used by this test"),
          exec: () => Effect.die("tank not used by this test"),
          spawnStream: (ctx, cmd) => {
            spawned.push(cmd)
            return spawnProcess(cmd, { cwd: ctx.cwd, env: ctx.env })
          },
          readFile: () => Effect.die("tank not used by this test"),
          writeFile: () => Effect.die("tank not used by this test"),
          writeHomeFile: () => Effect.die("tank not used by this test"),
          release: () => Effect.die("tank not used by this test"),
          worktrees: () => Effect.die("tank not used by this test"),
          removeWorktree: () => Effect.die("tank not used by this test"),
        }
        try {
          const ctx: TankContext = {
            botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
            botName: "live",
            cwd: workdir,
            home: process.env.HOME ?? workdir,
            env: liveEnv(workdir),
          }
          const scope = `live:${randomUUID()}`
          const executor = makeClaudeCodeChat()
          const turn = (): Effect.Effect<ReadonlyArray<ExecutorEvent>, unknown, ChatSessions> =>
            Stream.runCollect(runChatTurn(executor, scope, chatTask(), ctx)).pipe(
              Effect.scoped,
              Effect.provideService(Tank, recordingTank),
            )

          const startedFirst = Date.now()
          const first = yield* turn()
          const firstMs = Date.now() - startedFirst
          const startedSecond = Date.now()
          const second = yield* turn()
          const secondMs = Date.now() - startedSecond

          console.log(`chat latency message 1: ${firstMs} ms, message 2: ${secondMs} ms`)
          console.log(`chat cache tokens message 1: ${cacheOf(first)}; message 2: ${cacheOf(second)}`)

          const lastFirst = first.at(-1)
          const lastSecond = second.at(-1)
          expect(lastFirst?.kind).toBe("done")
          expect(lastFirst?.kind === "done" ? lastFirst.result.toLowerCase() : "").toContain("pong")
          expect(lastSecond?.kind).toBe("done")
          expect(lastSecond?.kind === "done" ? lastSecond.result.toLowerCase() : "").toContain("pong")

          expect(spawned).toHaveLength(2)
          expect(spawned[0]).not.toContain("--resume")
          const resumeIndex = spawned[1]?.indexOf("--resume") ?? -1
          expect(resumeIndex).toBeGreaterThan(-1)
          expect(spawned[1]?.[resumeIndex + 1]).toBe(
            lastFirst?.kind === "done" ? lastFirst.sessionId : undefined,
          )
        } finally {
          rmSync(workdir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(Layer.provideMerge(ChatSessionsLive, withTempDb()))),
    // Two cold-ish CLI starts with the real account; the default 5 s timeout is too tight.
    180_000,
  )
})
