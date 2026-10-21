import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import {
  BotId,
  ExecutorId,
  type ExecutorProtocolError,
  type ExecutorSpawnError,
  type ExecutorTask,
  TaskId,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { makeClaudeCode } from "../../src/claude-code/index.js"
import { makeCodexExecutor } from "../../src/codex/index.js"
import type { Executor } from "../../src/executor.js"
import { QuotaConfig } from "../../src/quota/config.js"
import { makeQuotaStore, type QuotaStoreShape } from "../../src/quota/store.js"

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")

// Synthetic test limits (not the shipped config): codex 1,000,000 tokens per 5h, claude-code 100,000 per 5h.
const config = Schema.decodeUnknownSync(QuotaConfig)({
  executors: {
    codex: { windows: [{ kind: "5h", soft_tokens: 1_000_000 }] },
    "claude-code": { windows: [{ kind: "5h", soft_tokens: 100_000 }] },
  },
})

const fixtureLines = (executor: "codex" | "claude-code", name: string): ReadonlyArray<string> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${executor}/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: "/tank/bot-a/work/step-1",
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home" },
}

const task: ExecutorTask = {
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  prompt: "say pong",
  tier: "light",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 5,
  budget: { tokens: 1_000_000, seconds: 600, usd: 10 },
}

// A process whose stdout is the given lines; stderr is empty and the exit code is 0.
const fakeProcess = (lines: ReadonlyArray<string>): RunningProcess => ({
  pid: 4242,
  stdout: Stream.fromIterable(lines),
  stderr: Stream.empty,
  exitCode: Effect.succeed(0),
  writeStdin: () => Effect.void,
  closeStdin: () => Effect.void,
  kill: () => Effect.void,
})

const tankWith = (proc: RunningProcess): TankShape => {
  const unused = () => Effect.die("tank not used by the adapter under test")
  return {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: () => Effect.succeed(proc),
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
}

const runWith = (
  executor: Executor,
  lines: ReadonlyArray<string>,
): Effect.Effect<void, ExecutorSpawnError | ExecutorProtocolError, Scope.Scope> =>
  Stream.runDrain(executor.run(task, ctx)).pipe(Effect.provideService(Tank, tankWith(fakeProcess(lines))))

// A fresh temporary database with the migrations applied, and a store over it on a fixed clock.
const withStore = <A, E, R>(body: (store: QuotaStoreShape) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return yield* body(makeQuotaStore(sql, config, () => Date.UTC(2026, 9, 21, 12, 0, 0)))
  }).pipe(Effect.provide(withTempDb()))

describe("codex adapter with a quota store", () => {
  it.effect("records the usage of a successful run into the store", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const executor = makeCodexExecutor({
          quotaWindowSeconds: 3600,
          quotaSoftLimitTokens: 1,
          quota: store,
        })
        yield* Effect.scoped(runWith(executor, fixtureLines("codex", "success.ndjson")))
        // success.ndjson: 24008 input and 171 output tokens on its one turn.
        const status = yield* executor.quota()
        expect(status.executor).toBe(CODEX)
        expect(status.usedRatio).toBeCloseTo(24179 / 1_000_000, 6)
        expect(status.available).toBe(true)
      }),
    ),
  )

  // SYNTHETIC limit text: no real codex limit message has been captured yet (UNVERIFIED).
  it.effect("marks the executor exhausted when a failed turn names a limit", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const executor = makeCodexExecutor({
          quotaWindowSeconds: 3600,
          quotaSoftLimitTokens: 1,
          quota: store,
        })
        const failed = JSON.stringify({
          type: "turn.failed",
          error: { message: "usage limit reached for this plan" },
        })
        yield* Effect.scoped(runWith(executor, [failed]))
        expect((yield* executor.quota()).available).toBe(false)
      }),
    ),
  )
})

describe("claude-code adapter with a quota store", () => {
  it.effect("records the usage of a successful run into the store", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const executor = makeClaudeCode({ quota: store })
        yield* Effect.scoped(runWith(executor, fixtureLines("claude-code", "success.ndjson")))
        // success.ndjson: 2 input and 4 output tokens; cache tokens are not counted.
        const status = yield* executor.quota()
        expect(status.executor).toBe(CLAUDE)
        expect(status.usedRatio).toBeCloseTo(6 / 100_000, 9)
        expect(status.available).toBe(true)
      }),
    ),
  )

  // SYNTHETIC result line: the 429 text is invented for the test (no real claude-code 429 captured yet).
  it.effect("marks the executor exhausted when its result names an HTTP 429", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const executor = makeClaudeCode({ quota: store })
        const result = JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "API Error: 429 rate limited",
          session_id: "00000000-0000-4000-8000-000000000003",
        })
        yield* Effect.scoped(runWith(executor, [result]))
        expect((yield* executor.quota()).available).toBe(false)
      }),
    ),
  )

  it.effect("reports unlimited when no store is injected", () =>
    Effect.gen(function* () {
      const executor = makeClaudeCode()
      expect(yield* executor.quota()).toEqual({ executor: CLAUDE, usedRatio: 0, available: true })
    }),
  )
})
