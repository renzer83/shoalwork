import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  type ExecutorTask,
  SessionId,
  type TankError,
  TaskId,
} from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import type { Executor } from "../../src/executor.js"
import { makeOpencode } from "../../src/opencode/index.js"

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/opencode/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const CWD = "/tank/bot-a/work/step-1"
const PROMPT = "fix the failing test"
const MODEL = "zai-coding-plan/glm-5.3"

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: CWD,
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home" },
}

const task = (overrides: Partial<ExecutorTask> = {}): ExecutorTask => ({
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  prompt: PROMPT,
  tier: "heavy",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 10,
  budget: { tokens: 1_000_000, seconds: 600, usd: 10 },
  ...overrides,
})

// A process whose stdout and stderr are the given lines and whose exit code is fixed.
const fakeProcess = (options: {
  readonly lines?: ReadonlyArray<string>
  readonly stderr?: ReadonlyArray<string>
  readonly exitCode?: number
}) => {
  const state = { killed: 0, stdinClosed: false }
  const proc: RunningProcess = {
    pid: 4242,
    stdout: Stream.fromIterable(options.lines ?? []),
    stderr: Stream.fromIterable(options.stderr ?? []),
    exitCode: Effect.succeed(options.exitCode ?? 0),
    writeStdin: () => Effect.void,
    closeStdin: () =>
      Effect.sync(() => {
        state.stdinClosed = true
      }),
    kill: () =>
      Effect.sync(() => {
        state.killed += 1
      }),
  }
  return { proc, state }
}

type Written = { readonly rel: string; readonly content: string }

// Records every argv handed to spawnStream and every file written, and serves the given process.
const recordingTank = (proc: RunningProcess) => {
  const argvs: Array<ReadonlyArray<string>> = []
  const writes: Array<Written> = []
  const unused = () => Effect.die("tank not used by the opencode executor")
  const shape: TankShape = {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: (_ctx, cmd) =>
      Effect.sync(() => {
        argvs.push(cmd)
        return proc
      }),
    readFile: unused,
    writeFile: (_ctx, rel, content): Effect.Effect<void, TankError> =>
      Effect.sync(() => {
        writes.push({ rel, content })
      }),
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
  return { shape, argvs, writes }
}

const collect = (executor: Executor, runTask: ExecutorTask, shape: TankShape) =>
  Stream.runCollect(executor.run(runTask, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

const executor = (): Executor =>
  makeOpencode({
    models: { chat: MODEL, decision: MODEL, light: MODEL, heavy: MODEL },
    quotaWindowSeconds: 3600,
    quotaSoftLimitTokens: 1_000_000,
  })

const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

const EXPECTED_ARGV = [
  "opencode",
  "run",
  "--format",
  "json",
  "--auto",
  "--dir",
  CWD,
  "-m",
  MODEL,
  "--",
  PROMPT,
]

describe("opencode run", () => {
  it.effect("spawns opencode with the run argv and closes stdin so the prompt is the only input", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      yield* collect(executor(), task(), shape)
      expect(argvs).toEqual([EXPECTED_ARGV])
      expect(state.stdinClosed).toBe(true)
    }),
  )

  it.effect("writes opencode.json without a permission rule for edit mode, before spawning", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, writes } = recordingTank(proc)
      yield* collect(executor(), task({ permissionMode: "edit" }), shape)
      expect(writes).toHaveLength(1)
      expect(writes[0]?.rel).toBe("opencode.json")
      expect(writes[0]?.content).not.toContain("permission")
    }),
  )

  it.effect("denies edit and bash in opencode.json for a readonly task", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, writes } = recordingTank(proc)
      yield* collect(executor(), task({ permissionMode: "readonly" }), shape)
      expect(writes[0]?.content).toContain('"edit": "deny"')
      expect(writes[0]?.content).toContain('"bash": "deny"')
    }),
  )

  it.effect("success fixture ends with usage and a done carrying the last text", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const events: ReadonlyArray<ExecutorEvent> = yield* collect(executor(), task(), shape)
      expect(kinds(events)).toContain("usage")
      expect(events.at(-1)).toEqual({
        kind: "done",
        result: "done",
        artifacts: [],
        sessionId: Schema.decodeUnknownSync(SessionId)("ses_ea1da029bffeQWy9YtxZFXU6TF"),
      })
    }),
  )

  it.effect("error fixture ends with an unknown error carrying the message, exit 1", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("error.ndjson"), exitCode: 1 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task({ tier: "chat" }), shape)
      expect(events).toEqual([
        { kind: "started", sessionId: Schema.decodeUnknownSync(SessionId)("ses_ea1da191bffeoLWjV2OfJlEfVI") },
        {
          kind: "error",
          code: "unknown",
          message: "Unexpected server error. Check server logs for details.",
        },
      ])
    }),
  )

  it.effect("exit 1 without an error line reports the exit code and the redacted stderr tail", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: [], stderr: ["crash in provider"], exitCode: 2 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        {
          kind: "error",
          code: "unknown",
          message: "opencode exited with code 2 without a result; stderr: crash in provider",
        },
      ])
    }),
  )

  it.effect("exit 0 with no terminal line is done, with the last text as the result", () =>
    Effect.gen(function* () {
      const line = JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_only",
        part: { id: "p", type: "text", text: "partial answer" },
      })
      const { proc } = fakeProcess({ lines: [line], exitCode: 0 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events.at(-1)).toEqual({
        kind: "done",
        result: "partial answer",
        artifacts: [],
        sessionId: Schema.decodeUnknownSync(SessionId)("ses_only"),
      })
    }),
  )

  it.effect("refuses a model that is not provider/model before spawning anything", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs, writes } = recordingTank(proc)
      const bad = makeOpencode({
        models: { chat: "glm-5.3", decision: MODEL, light: MODEL, heavy: MODEL },
        quotaWindowSeconds: 3600,
        quotaSoftLimitTokens: 1_000_000,
      })
      const events = yield* collect(bad, task({ tier: "chat" }), shape)
      expect(events).toEqual([
        {
          kind: "error",
          code: "unknown",
          message: 'config: opencode model must be provider/model, got "glm-5.3"',
        },
      ])
      expect(argvs).toEqual([])
      expect(writes).toEqual([])
    }),
  )

  it.effect("the task's model replaces the tier model on the argv", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      yield* collect(executor(), task({ model: "ollama/qwen3" }), shape)
      const argv = argvs[0] ?? []
      expect(argv[argv.indexOf("-m") + 1]).toBe("ollama/qwen3")
    }),
  )

  it.effect("spawns the resume argv with -s when the task carries a session id", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      const sessionId = Schema.decodeUnknownSync(SessionId)("ses_abc123")
      yield* collect(executor(), task({ resumeSessionId: sessionId, prompt: "continue" }), shape)
      expect(argvs).toEqual([
        [
          "opencode",
          "run",
          "--format",
          "json",
          "--auto",
          "--dir",
          CWD,
          "-m",
          MODEL,
          "-s",
          "ses_abc123",
          "--",
          "continue",
        ],
      ])
    }),
  )

  it.effect("cuts the run with a budget error when the token budget is spent", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(
        executor(),
        task({ budget: { tokens: 10, seconds: 600, usd: 10 } }),
        shape,
      )
      expect(events.at(-1)).toEqual({ kind: "error", code: "budget", message: "token budget of 10 exceeded" })
      expect(state.killed).toBeGreaterThan(0)
    }),
  )
})
