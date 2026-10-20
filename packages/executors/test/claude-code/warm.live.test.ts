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
import { ChatSessionsLive } from "../../src/claude-code/sessions.js"
import { makeWarmChatPool } from "../../src/claude-code/warm.js"

// Real CLI, real account: runs only with LIVE=1 (ADR-011). One warm process answers three messages of one scope.
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

const chatTask = (prompt: string): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt,
    tier: "chat",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 1,
    budget: { tokens: 20000, seconds: 60, usd: 0.5 },
  })

// The spec target is < 2 s for messages 2 and 3, but the measured latency swings between 1 s and 2.6 s from run to run
// (06-research/claude-code.md §10), so the default bound only catches a regression to one-shot cold starts.
// LIVE_STRICT=1 enforces the 2 s target.
const MAX_WARM_MS = process.env.LIVE_STRICT === "1" ? 2000 : 5000

describe.skipIf(!live)("claude-code warm chat live", () => {
  it.live(
    "answers three messages of one scope on a single process and stores the session",
    () =>
      Effect.gen(function* () {
        const workdir = mkdtempSync(join(tmpdir(), "claude-warm-live-"))
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
          release: () => Effect.die("tank not used by this test"),
        }
        try {
          const ctx: TankContext = {
            botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
            botName: "live",
            cwd: workdir,
            home: process.env.HOME ?? workdir,
            env: liveEnv(workdir),
          }
          const scope = `live-warm:${randomUUID()}`
          const executor = makeClaudeCodeChat()
          const prompts = [
            "reply with the single word pong",
            "reply with the single word ping",
            "which two words did you reply with so far? answer in one short line",
          ]
          const latencies: Array<number> = []
          const answers: Array<ReadonlyArray<ExecutorEvent>> = []
          yield* Effect.scoped(
            Effect.gen(function* () {
              const warm = yield* makeWarmChatPool()
              for (const prompt of prompts) {
                const started = Date.now()
                const events = yield* Stream.runCollect(
                  runChatTurn(executor, scope, chatTask(prompt), ctx, { warm }),
                ).pipe(Effect.scoped)
                latencies.push(Date.now() - started)
                answers.push([...events])
              }
            }),
          ).pipe(Effect.provideService(Tank, recordingTank))

          console.log(`warm chat latency (ms): ${latencies.join(", ")}`)

          expect(spawned).toHaveLength(1)
          expect(spawned[0]).toContain("--input-format")
          expect(spawned[0]?.some((arg) => prompts.includes(arg))).toBe(false)
          const results = answers.map((events) => {
            const done = events.find((event) => event.kind === "done")
            return done?.kind === "done" ? done.result.toLowerCase() : ""
          })
          expect(results[0]).toContain("pong")
          expect(results[1]).toContain("ping")
          expect(results[2]).toContain("pong")
          expect(results[2]).toContain("ping")
          const sessionIds = answers.map((events) => {
            const done = events.find((event) => event.kind === "done")
            return done?.kind === "done" ? done.sessionId : undefined
          })
          expect(new Set(sessionIds).size).toBe(1)
          expect(latencies[1]).toBeLessThan(MAX_WARM_MS)
          expect(latencies[2]).toBeLessThan(MAX_WARM_MS)
        } finally {
          rmSync(workdir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(Layer.provideMerge(ChatSessionsLive, withTempDb()))),
    180_000,
  )
})
