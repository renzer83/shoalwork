import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  SessionId,
  TankError,
  TaskId,
} from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import type { Executor } from "../../src/executor.js"
import { makeGemini } from "../../src/gemini/index.js"

// Fixtures under test/fixtures/gemini are synthetic (see events.test.ts): no logged-in Gemini CLI to record from.

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/gemini/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const CWD = "/tank/bot-a/work/step-1"
const HOME = "/tank/bot-a/home"
const PROMPT = "fix the failing test"

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: CWD,
  home: HOME,
  env: { HOME, GEMINI_CLI_HOME: HOME },
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

// A process whose stdout and stderr are the given lines and whose exit code is fixed. `killed` counts kill calls.
const fakeProcess = (options: {
  readonly lines?: ReadonlyArray<string>
  readonly stdout?: Stream.Stream<string, TankError>
  readonly stderr?: ReadonlyArray<string>
  readonly exitCode?: number
}) => {
  const state = { killed: 0, stdinClosed: false }
  const proc: RunningProcess = {
    pid: 4343,
    stdout: options.stdout ?? Stream.fromIterable(options.lines ?? []),
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

const tankWith = (spawnStream: TankShape["spawnStream"]): TankShape => {
  const unused = () => Effect.die("tank not used by the gemini executor")
  return {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream,
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
}

// Records every argv and env handed to spawnStream and serves the given process.
const recordingTank = (proc: RunningProcess) => {
  const spawns: Array<{
    readonly cmd: ReadonlyArray<string>
    readonly env: Readonly<Record<string, string>>
  }> = []
  const shape = tankWith((spawnCtx, cmd) =>
    Effect.sync(() => {
      spawns.push({ cmd, env: spawnCtx.env })
      return proc
    }),
  )
  return { shape, spawns }
}

const collect = (executor: Executor, runTask: ExecutorTask, shape: TankShape) =>
  Stream.runCollect(executor.run(runTask, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

const executor = () => makeGemini()

describe("gemini run", () => {
  it.effect("spawns gemini with the run argv and closes stdin so the prompt is the only input", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, spawns } = recordingTank(proc)
      yield* collect(executor(), task(), shape)
      expect(spawns.map((spawn) => spawn.cmd)).toEqual([
        [
          "gemini",
          `--prompt=${PROMPT}`,
          "--output-format",
          "stream-json",
          "--approval-mode",
          "auto_edit",
          "-m",
          "gemini-pro-latest",
        ],
      ])
      expect(state.stdinClosed).toBe(true)
    }),
  )

  it.effect("points the CLI home at the Bot's home, and applies the executor env overrides", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, spawns } = recordingTank(proc)
      const gemini = makeGemini({ envOverrides: { GEMINI_API_KEY: "placeholder" } })
      yield* collect(gemini, task(), shape)
      expect(spawns[0]?.env.GEMINI_CLI_HOME).toBe(HOME)
      expect(spawns[0]?.env.GEMINI_API_KEY).toBe("placeholder")
    }),
  )

  it.effect("spawns the resume argv with --resume when the task carries a session id", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, spawns } = recordingTank(proc)
      const sessionId = Schema.decodeUnknownSync(SessionId)("6f1c2a4e-1111-4a2b-9c3d-000000000001")
      yield* collect(executor(), task({ resumeSessionId: sessionId, prompt: "continue" }), shape)
      expect(spawns.map((spawn) => spawn.cmd)).toEqual([
        [
          "gemini",
          "--prompt=continue",
          "--output-format",
          "stream-json",
          "--approval-mode",
          "auto_edit",
          "-m",
          "gemini-pro-latest",
          "--resume=6f1c2a4e-1111-4a2b-9c3d-000000000001",
        ],
      ])
    }),
  )

  it.effect("success fixture emits started, text, usage and done in order", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(kinds(events)).toEqual(["started", "text", "usage", "done"])
      expect(events[0]).toEqual({
        kind: "started",
        sessionId: Schema.decodeUnknownSync(SessionId)("6f1c2a4e-1111-4a2b-9c3d-000000000001"),
        model: "gemini-pro-latest",
      })
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "pong", artifacts: [] })
    }),
  )

  it.effect("with-tools fixture yields at least one command and one file_edit", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("with-tools.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events.some((event) => event.kind === "command")).toBe(true)
      expect(events.some((event) => event.kind === "file_edit")).toBe(true)
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("error fixture with exit 53 ends with error max_turns carrying the result message", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("error.ndjson"), exitCode: 53 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(kinds(events)).toEqual([
        "started",
        "tool_call",
        "command",
        "tool_call",
        "command",
        "usage",
        "error",
      ])
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "max_turns",
        message: "Maximum session turns exceeded",
      })
    }),
  )

  it.effect("error fixture with exit 1 ends with error unknown carrying the result message", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("error.ndjson"), exitCode: 1 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "unknown",
        message: "Maximum session turns exceeded",
      })
    }),
  )

  it.effect("token budget cut emits error budget after usage and kills the process", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(
        executor(),
        task({ budget: { tokens: 10, seconds: 600, usd: 10 } }),
        shape,
      )
      expect(kinds(events)).toEqual(["started", "text", "usage", "error"])
      expect(events.at(-1)).toEqual({ kind: "error", code: "budget", message: "token budget of 10 exceeded" })
      expect(state.killed).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("wall-clock budget cuts a silent process with error budget and kills it", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ stdout: Stream.never })
      const { shape } = recordingTank(proc)
      const events = yield* collect(
        executor(),
        task({ budget: { tokens: 1_000_000, seconds: 1, usd: 10 } }),
        shape,
      )
      expect(events).toEqual([{ kind: "error", code: "budget", message: "wall-clock budget of 1s exceeded" }])
      expect(state.killed).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("non-zero exit without a result ends with error unknown", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: [], exitCode: 2 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        { kind: "error", code: "unknown", message: "gemini exited with code 2 without a result" },
      ])
    }),
  )

  it.effect("exit 53 without a result ends with error max_turns", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: [], exitCode: 53 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        { kind: "error", code: "max_turns", message: "gemini exited with code 53 without a result" },
      ])
    }),
  )

  it.effect("a silent exit 0 without a result ends with error protocol, not an empty stream", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: [], stderr: ["warning: stdin closed"] })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        {
          kind: "error",
          code: "protocol",
          message: "gemini ended without a result; stderr: warning: stdin closed",
        },
      ])
    }),
  )

  it.effect("a spawn failure fails the run with ExecutorSpawnError", () =>
    Effect.gen(function* () {
      const shape = tankWith(() => Effect.fail(new TankError({ op: "spawn", cause: "no such file" })))
      const error = yield* collect(executor(), task(), shape).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExecutorSpawnError)
      expect(error.executor).toBe("gemini")
    }),
  )

  it.effect("a non-JSON stdout line fails the run with ExecutorProtocolError", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: ["not json"] })
      const { shape } = recordingTank(proc)
      const error = yield* collect(executor(), task(), shape).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExecutorProtocolError)
      expect(error).toMatchObject({ _tag: "ExecutorProtocolError", line: "not json" })
    }),
  )
})
