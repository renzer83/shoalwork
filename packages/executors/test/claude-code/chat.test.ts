import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
  SessionId,
  type TankError,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Duration, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { describe, expect } from "vitest"
import { buildChatArgs, CHAT_MODEL } from "../../src/claude-code/args.js"
import { CHAT_ID, makeClaudeCodeChat, runChatTurn } from "../../src/claude-code/chat.js"
import { ChatSessions, ChatSessionsLive } from "../../src/claude-code/sessions.js"

const chatFixture = readFileSync(new URL("../fixtures/claude-code/chat.json", import.meta.url), "utf8").trim()
const FIXTURE_SESSION = "40e66dbf-beaf-4fc5-839d-ea3f883591f6"
const NEW_SESSION = "5b1f0c2e-0d4a-4e8c-9a51-2c7d6e9f1a20"
const OLD_SESSION = "00000000-0000-4000-8000-000000000000"

const chatTask = (overrides: Readonly<Record<string, unknown>> = {}): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "reply with the single word pong",
    tier: "chat",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 1,
    budget: { tokens: 1000, seconds: 60, usd: 0.5 },
    ...overrides,
  })

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  botName: "lead",
  cwd: "/work/bot",
  home: "/work/bot/home",
  env: { HOME: "/work/bot/home", PATH: "/usr/bin", ANTHROPIC_API_KEY: "test-key-placeholder" },
}

describe("buildChatArgs", () => {
  it("builds the chat argv in the documented order without resume", () => {
    expect(buildChatArgs(chatTask())).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-haiku-5-5",
      "--effort",
      "low",
      "--tools",
      "",
      "--max-turns",
      "1",
      "--permission-mode",
      "plan",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--",
      "reply with the single word pong",
    ])
  })

  it("adds --resume and --append-system-prompt before the separator when set", () => {
    const args = buildChatArgs(chatTask({ resumeSessionId: "sess-123", systemAppend: "Be brief." }))
    const separator = args.indexOf("--")
    expect(args.slice(separator - 4, separator)).toEqual([
      "--resume",
      "sess-123",
      "--append-system-prompt",
      "Be brief.",
    ])
    expect(args.at(-1)).toBe("reply with the single word pong")
  })

  it("never adds --bare and always disables builtin tools with an empty --tools value", () => {
    const args = buildChatArgs(chatTask())
    expect(args).not.toContain("--bare")
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(CHAT_MODEL).toBe("claude-haiku-5-5")
  })

  it("passes the empty MCP server config as one argv value, before the separator", () => {
    const args = buildChatArgs(chatTask())
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}')
    expect(args.indexOf("--strict-mcp-config")).toBeLessThan(args.indexOf("--"))
  })

  it.each(["--permission-mode=bypassPermissions", "-x", "--dangerously-skip-permissions"])(
    "keeps a prompt that looks like a flag (%s) after -- and leaves the flags unchanged",
    (prompt) => {
      const args = buildChatArgs(chatTask({ prompt }))
      const separator = args.indexOf("--")
      expect(args.slice(separator + 1)).toEqual([prompt])
      expect(args.slice(0, separator)).toEqual(buildChatArgs(chatTask()).slice(0, separator))
    },
  )
})

type Script = {
  readonly stdout: ReadonlyArray<string>
  readonly exitCode: number
  readonly hang?: boolean
  // Time the spawn takes before the process is handed back; used to make overlaps visible.
  readonly delayMs?: number
}

type Recorder = {
  readonly argv: Array<ReadonlyArray<string>>
  readonly envs: Array<Readonly<Record<string, string>>>
  kills: number
  inFlight: number
  maxInFlight: number
}

const emptyRecorder = (): Recorder => ({ argv: [], envs: [], kills: 0, inFlight: 0, maxInFlight: 0 })

// Each spawn consumes the next script. A hang keeps stdout open until the caller interrupts.
const scriptedTank = (scripts: Array<Script>, rec: Recorder): TankShape => ({
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: (spawnCtx, cmd): Effect.Effect<RunningProcess, TankError, Scope.Scope> =>
    Effect.gen(function* () {
      const next = scripts.shift()
      if (next === undefined) return yield* Effect.die("no script left for this spawn")
      rec.argv.push(cmd)
      rec.envs.push(spawnCtx.env)
      rec.inFlight += 1
      rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight)
      if (next.delayMs !== undefined) yield* Effect.sleep(Duration.millis(next.delayMs))
      rec.inFlight -= 1
      const process: RunningProcess = {
        pid: 1,
        stdout: next.hang === true ? Stream.never : Stream.fromIterable(next.stdout),
        stderr: Stream.empty,
        exitCode: Effect.succeed(next.exitCode),
        writeStdin: () => Effect.void,
        closeStdin: () => Effect.void,
        kill: () =>
          Effect.sync(() => {
            rec.kills += 1
          }),
      }
      return process
    }),
  readFile: () => Effect.die("tank not used by this test"),
  writeFile: () => Effect.die("tank not used by this test"),
  release: () => Effect.die("tank not used by this test"),
})

const resultLine = (sessionId: string, result: string): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
    total_cost_usd: 0.001,
    duration_ms: 1200,
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 },
  })

const errorResultLine = (sessionId: string): string =>
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["rate limited"],
    session_id: sessionId,
    total_cost_usd: 0,
    duration_ms: 10,
  })

const runWith = (scripts: Array<Script>, task: ExecutorTask, rec: Recorder, timeoutMs?: number) =>
  Stream.runCollect(makeClaudeCodeChat({ timeoutMs: timeoutMs ?? 20_000 }).run(task, ctx)).pipe(
    Effect.scoped,
    Effect.provideService(Tank, scriptedTank(scripts, rec)),
  )

const SessionsLayer = Layer.provideMerge(ChatSessionsLive, withTempDb())

const turn = (
  executor: ReturnType<typeof makeClaudeCodeChat>,
  scope: string,
  scripts: Array<Script>,
  rec: Recorder,
  task: ExecutorTask = chatTask(),
) =>
  Stream.runCollect(runChatTurn(executor, scope, task, ctx)).pipe(
    Effect.scoped,
    Effect.provideService(Tank, scriptedTank(scripts, rec)),
  )

const SESSION_TIMEOUT = "chat turn exceeded 50 ms"

describe("makeClaudeCodeChat", () => {
  it("has the chat executor id and maps chat and decision to haiku with low effort", () => {
    const executor = makeClaudeCodeChat()
    expect(executor.id).toBe(CHAT_ID)
    expect(executor.mapTier("chat")).toEqual({ model: "claude-haiku-5-5", effort: "low" })
    expect(executor.mapTier("decision")).toEqual({ model: "claude-haiku-5-5", effort: "low" })
  })

  it.effect("maps the json fixture to usage then done carrying the session id", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const task = chatTask()
      const events = yield* runWith([{ stdout: [chatFixture], exitCode: 0 }], task, rec)
      expect(events.at(-2)).toMatchObject({ kind: "usage", usage: { tokensIn: 2, tokensOut: 4 } })
      expect(events.at(-1)).toEqual({
        kind: "done",
        result: "pong",
        artifacts: [],
        sessionId: FIXTURE_SESSION,
      })
      expect(rec.argv[0]).toEqual(["claude", ...buildChatArgs(task)])
    }),
  )

  it.effect("drops ANTHROPIC_API_KEY from the spawned environment", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* runWith([{ stdout: [chatFixture], exitCode: 0 }], chatTask(), rec)
      expect(rec.envs[0]).not.toHaveProperty("ANTHROPIC_API_KEY")
      expect(rec.envs[0]?.HOME).toBe("/work/bot/home")
    }),
  )

  it.effect("refuses light and heavy tiers with an error event and never spawns", () =>
    Effect.gen(function* () {
      for (const tier of ["heavy", "light"] as const) {
        const rec = emptyRecorder()
        const events = yield* runWith([], chatTask({ tier }), rec)
        expect(events).toEqual([
          { kind: "error", code: "unknown", message: "tier not supported by chat mode" },
        ])
        expect(rec.argv).toHaveLength(0)
      }
    }),
  )

  it.effect(
    "retries without --resume when the resumed turn printed no result, and reports the new session",
    () =>
      Effect.gen(function* () {
        const rec = emptyRecorder()
        const events = yield* runWith(
          [
            { stdout: [], exitCode: 1 },
            { stdout: [resultLine(NEW_SESSION, "pong")], exitCode: 0 },
          ],
          chatTask({ resumeSessionId: OLD_SESSION }),
          rec,
        )
        expect(rec.argv).toHaveLength(2)
        expect(rec.argv[0]).toContain("--resume")
        expect(rec.argv[1]).not.toContain("--resume")
        expect(events.at(-1)).toEqual({ kind: "done", result: "pong", artifacts: [], sessionId: NEW_SESSION })
      }),
  )

  it.effect("does not retry a resumed turn whose result carries an error", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* runWith(
        [{ stdout: [errorResultLine(OLD_SESSION)], exitCode: 1 }],
        chatTask({ resumeSessionId: OLD_SESSION }),
        rec,
      )
      expect(rec.argv).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ kind: "error", message: "rate limited" })
    }),
  )

  it.live("ends with error unknown and kills the process when the turn exceeds the timeout", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* runWith([{ stdout: [], exitCode: 0, hang: true }], chatTask(), rec, 50)
      expect(events).toEqual([{ kind: "error", code: "unknown", message: SESSION_TIMEOUT }])
      expect(rec.kills).toBe(1)
    }),
  )

  it.live("a timed-out resumed turn is not retried", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* runWith(
        [{ stdout: [], exitCode: 0, hang: true }],
        chatTask({ resumeSessionId: OLD_SESSION }),
        rec,
        50,
      )
      expect(events).toEqual([{ kind: "error", code: "unknown", message: SESSION_TIMEOUT }])
      expect(rec.argv).toHaveLength(1)
    }),
  )

  it.live("the retry gets only the time left of the same budget", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const started = Date.now()
      const events = yield* runWith(
        [
          { stdout: [], exitCode: 1, delayMs: 80 },
          { stdout: [], exitCode: 0, hang: true },
        ],
        chatTask({ resumeSessionId: OLD_SESSION }),
        rec,
        100,
      )
      expect(rec.argv).toHaveLength(2)
      expect(events).toEqual([{ kind: "error", code: "unknown", message: "chat turn exceeded 100 ms" }])
      expect(Date.now() - started).toBeLessThan(190)
    }),
  )
})

describe("ChatSessions", () => {
  it.effect("returns none for an unknown scope, then the stored session, and overwrites it", () =>
    Effect.gen(function* () {
      const sessions = yield* ChatSessions
      const scope = "telegram:-100:7"
      expect(Option.isNone(yield* sessions.get(scope))).toBe(true)
      yield* sessions.set(scope, Schema.decodeUnknownSync(SessionId)("sess-a"))
      expect(yield* sessions.get(scope)).toEqual(Option.some("sess-a"))
      yield* sessions.set(scope, Schema.decodeUnknownSync(SessionId)("sess-b"))
      expect(yield* sessions.get(scope)).toEqual(Option.some("sess-b"))
    }).pipe(Effect.provide(SessionsLayer)),
  )
})

describe("runChatTurn", () => {
  it.effect("first turn starts fresh, the next turn of the same scope resumes the stored session", () =>
    Effect.gen(function* () {
      const scope = `app:${randomUUID()}:user`
      const executor = makeClaudeCodeChat()
      const rec = emptyRecorder()
      const scripts: Array<Script> = [
        { stdout: [resultLine(FIXTURE_SESSION, "pong")], exitCode: 0 },
        { stdout: [resultLine(FIXTURE_SESSION, "pong again")], exitCode: 0 },
      ]
      yield* turn(executor, scope, scripts, rec)
      yield* turn(executor, scope, scripts, rec)
      expect(rec.argv[0]).not.toContain("--resume")
      expect(rec.argv[1]).toContain("--resume")
      expect(rec.argv[1]?.[rec.argv[1].indexOf("--resume") + 1]).toBe(FIXTURE_SESSION)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.effect("a failed resume starts a new session and stores its id", () =>
    Effect.gen(function* () {
      const sessions = yield* ChatSessions
      const scope = `app:${randomUUID()}:user`
      yield* sessions.set(scope, Schema.decodeUnknownSync(SessionId)(OLD_SESSION))
      const rec = emptyRecorder()
      yield* turn(
        makeClaudeCodeChat(),
        scope,
        [
          { stdout: [], exitCode: 1 },
          { stdout: [resultLine(NEW_SESSION, "pong")], exitCode: 0 },
        ],
        rec,
      )
      expect(yield* sessions.get(scope)).toEqual(Option.some(NEW_SESSION))
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.effect("when the retry fails too, returns its error and keeps the stored session", () =>
    Effect.gen(function* () {
      const sessions = yield* ChatSessions
      const scope = `app:${randomUUID()}:user`
      yield* sessions.set(scope, Schema.decodeUnknownSync(SessionId)(OLD_SESSION))
      const rec = emptyRecorder()
      const events = yield* turn(
        makeClaudeCodeChat(),
        scope,
        [
          { stdout: [], exitCode: 1 },
          { stdout: [], exitCode: 1 },
        ],
        rec,
      )
      expect(rec.argv).toHaveLength(2)
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "unknown",
        message: "claude exited with code 1 without a result",
      })
      expect(yield* sessions.get(scope)).toEqual(Option.some(OLD_SESSION))
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("two messages of one scope never overlap: the second resumes the session the first stored", () =>
    Effect.gen(function* () {
      const scope = `app:${randomUUID()}:user`
      const rec = emptyRecorder()
      const scripts: Array<Script> = [
        { stdout: [resultLine(FIXTURE_SESSION, "pong")], exitCode: 0, delayMs: 60 },
        { stdout: [resultLine(FIXTURE_SESSION, "pong again")], exitCode: 0, delayMs: 60 },
      ]
      const executor = makeClaudeCodeChat()
      yield* Effect.all([turn(executor, scope, scripts, rec), turn(executor, scope, scripts, rec)], {
        concurrency: "unbounded",
      })
      const sessions = yield* ChatSessions
      expect(rec.maxInFlight).toBe(1)
      const withResume = rec.argv.filter((args) => args.includes("--resume"))
      expect(rec.argv.filter((args) => !args.includes("--resume"))).toHaveLength(1)
      expect(withResume).toHaveLength(1)
      expect(withResume[0]?.[withResume[0].indexOf("--resume") + 1]).toBe(FIXTURE_SESSION)
      expect(yield* sessions.get(scope)).toEqual(Option.some(FIXTURE_SESSION))
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("different scopes run in parallel", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const scripts: Array<Script> = [
        { stdout: [resultLine(NEW_SESSION, "a")], exitCode: 0, delayMs: 100 },
        { stdout: [resultLine(NEW_SESSION, "b")], exitCode: 0, delayMs: 100 },
      ]
      const executor = makeClaudeCodeChat()
      yield* Effect.all(
        [
          turn(executor, `app:${randomUUID()}:user`, scripts, rec),
          turn(executor, `app:${randomUUID()}:user`, scripts, rec),
        ],
        { concurrency: "unbounded" },
      )
      expect(rec.maxInFlight).toBe(2)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.effect("a failed save does not hide the done event", () =>
    Effect.gen(function* () {
      const failing = {
        get: () => Effect.succeed(Option.none()),
        set: () =>
          Effect.fail(
            new SqlError({ reason: new UnknownError({ message: "write failed", cause: undefined }) }),
          ),
        withScope: <A, E, R>(_scope: string, effect: Effect.Effect<A, E, R>) => effect,
      }
      const rec = emptyRecorder()
      const events = yield* turn(
        makeClaudeCodeChat(),
        `app:${randomUUID()}:user`,
        [{ stdout: [resultLine(NEW_SESSION, "pong")], exitCode: 0 }],
        rec,
      ).pipe(Effect.provide(Layer.succeed(ChatSessions, failing)))
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "pong", sessionId: NEW_SESSION })
    }),
  )
})
