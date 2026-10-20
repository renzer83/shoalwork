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
import { makeCodexExecutor } from "../../src/codex/index.js"
import type { Executor } from "../../src/executor.js"

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/codex/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const CWD = "/tank/bot-a/work/step-1"
const PROMPT = "fix the failing test"

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: CWD,
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home", CODEX_HOME: "/tank/bot-a/home/.codex" },
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
    pid: 4242,
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
  const unused = () => Effect.die("tank not used by the codex executor")
  return {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream,
    readFile: unused,
    writeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
}

// Records every argv handed to spawnStream and serves the given process.
const recordingTank = (proc: RunningProcess) => {
  const argvs: Array<ReadonlyArray<string>> = []
  const shape = tankWith((_ctx, cmd) =>
    Effect.sync(() => {
      argvs.push(cmd)
      return proc
    }),
  )
  return { shape, argvs }
}

const collect = (executor: Executor, runTask: ExecutorTask, shape: TankShape) =>
  Stream.runCollect(executor.run(runTask, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

const executor = () => makeCodexExecutor({ quotaWindowSeconds: 3600, quotaSoftLimitTokens: 1_000_000 })

describe("codex run", () => {
  it.effect("spawns codex with the run argv and closes stdin so the prompt is the only input", () =>
    Effect.gen(function* () {
      const { proc, state } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      yield* collect(executor(), task(), shape)
      expect(argvs).toEqual([
        [
          "codex",
          "exec",
          "--json",
          "--skip-git-repo-check",
          "-C",
          CWD,
          "-s",
          "workspace-write",
          "-c",
          "approval_policy=never",
          "--",
          PROMPT,
        ],
      ])
      expect(state.stdinClosed).toBe(true)
    }),
  )

  it.effect("passes -m for a tier configured in the executor options", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      const codex = makeCodexExecutor({
        quotaWindowSeconds: 3600,
        quotaSoftLimitTokens: 1_000_000,
        models: { heavy: "gpt-5.6-luna" },
      })
      yield* collect(codex, task({ tier: "heavy" }), shape)
      const argv = argvs[0] ?? []
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.6-luna")
    }),
  )

  it.effect("the task's own model replaces the tier model on the run argv", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      const codex = makeCodexExecutor({
        quotaWindowSeconds: 3600,
        quotaSoftLimitTokens: 1_000_000,
        models: { heavy: "gpt-5.6-luna" },
      })
      yield* collect(codex, task({ tier: "heavy", model: "gpt-task-model" }), shape)
      const argv = argvs[0] ?? []
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-task-model")
    }),
  )

  it.effect("spawns the resume argv when the task carries a session id", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      const sessionId = Schema.decodeUnknownSync(SessionId)("thread-7")
      yield* collect(executor(), task({ resumeSessionId: sessionId, prompt: "continue" }), shape)
      expect(argvs).toEqual([
        ["codex", "exec", "resume", "--skip-git-repo-check", "thread-7", "--json", "--", "continue"],
      ])
    }),
  )

  it.effect("passes -m on the resume argv when the tier has a configured model", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape, argvs } = recordingTank(proc)
      const sessionId = Schema.decodeUnknownSync(SessionId)("thread-8")
      const codex = makeCodexExecutor({
        quotaWindowSeconds: 3600,
        quotaSoftLimitTokens: 1_000_000,
        models: { heavy: "gpt-5.6-luna" },
      })
      yield* collect(codex, task({ resumeSessionId: sessionId, prompt: "continue" }), shape)
      expect(argvs).toEqual([
        [
          "codex",
          "exec",
          "resume",
          "--skip-git-repo-check",
          "-m",
          "gpt-5.6-luna",
          "thread-8",
          "--json",
          "--",
          "continue",
        ],
      ])
    }),
  )

  it.effect("success fixture emits started, command, text, usage and done in order", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(kinds(events)).toEqual(["started", "command", "text", "usage", "done"])
      expect(events[0]).toEqual({
        kind: "started",
        sessionId: Schema.decodeUnknownSync(SessionId)("01a15906-8be5-7ab3-8bb9-a341ae3ec04f"),
      })
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        result: "done",
        artifacts: [],
        sessionId: "01a15906-8be5-7ab3-8bb9-a341ae3ec04f",
      })
      expect(events[3]).toEqual({
        kind: "usage",
        usage: { tokensIn: 24008, tokensOut: 171, cacheRead: 22016, cacheWrite: 0, usd: 0, seconds: 0 },
      })
    }),
  )

  it.effect("success fixture records its usage in the executor quota", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("success.ndjson") })
      const { shape } = recordingTank(proc)
      const codex = executor()
      yield* collect(codex, task(), shape)
      const status = yield* codex.quota()
      expect(status.usedRatio).toBeCloseTo(24179 / 1_000_000, 6)
      expect(status.available).toBe(true)
    }),
  )

  it.effect("failed fixture ends with error unknown carrying the codex message", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: fixture("failed.ndjson") })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(kinds(events)).toEqual(["started", "error"])
      const last = events.at(-1)
      expect(last).toMatchObject({ kind: "error", code: "unknown" })
      expect(last?.kind === "error" && last.message).toContain("gpt-5.5")
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
      expect(kinds(events)).toEqual(["started", "command", "text", "usage", "error"])
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

  it.effect("non-zero exit without a terminal event ends with error unknown", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({ lines: [], exitCode: 2 })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        { kind: "error", code: "unknown", message: "codex exited with code 2 without a result" },
      ])
    }),
  )

  it.effect("a process that exits 1 without a result carries the redacted stderr tail", () =>
    Effect.gen(function* () {
      const { proc } = fakeProcess({
        lines: [],
        exitCode: 1,
        stderr: ["Error: no rollout found", "auth token=xyz", "proxy http://u:p@proxy.test:3128"],
      })
      const { shape } = recordingTank(proc)
      const events = yield* collect(executor(), task(), shape)
      expect(events).toEqual([
        {
          kind: "error",
          code: "unknown",
          message: [
            "codex exited with code 1 without a result; stderr: Error: no rollout found",
            "[redacted]",
            "proxy http://***@proxy.test:3128",
          ].join("\n"),
        },
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
          message: "codex ended without a result; stderr: warning: stdin closed",
        },
      ])
    }),
  )

  it.effect("a spawn failure fails the run with ExecutorSpawnError", () =>
    Effect.gen(function* () {
      const shape = tankWith(() => Effect.fail(new TankError({ op: "spawn", cause: "no such file" })))
      const error = yield* collect(executor(), task(), shape).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExecutorSpawnError)
      expect(error.executor).toBe("codex")
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
