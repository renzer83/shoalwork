import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
  TankError,
} from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import { describe, expect } from "vitest"
import { buildArgs } from "../../src/claude-code/args.js"
import { defaultMapTier, makeClaudeCode } from "../../src/claude-code/index.js"
import { ExecutorRegistry, makeRegistry } from "../../src/executor.js"

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(new URL(`../fixtures/claude-code/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

type SpawnCall = { readonly ctx: TankContext; readonly cmd: ReadonlyArray<string> }

type FakeProcessOptions = { readonly stderr?: ReadonlyArray<string>; readonly exitCode?: number }

// A Tank whose spawnStream replays the given stdout and stderr lines. Records the spawn and the stdin closes.
const fakeTank = (
  stdout: ReadonlyArray<string>,
  calls: Array<SpawnCall>,
  closes: { count: number },
  options: FakeProcessOptions = {},
): TankShape => ({
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: (ctx, cmd) => {
    calls.push({ ctx, cmd })
    const process: RunningProcess = {
      pid: 1,
      stdout: Stream.fromIterable(stdout),
      stderr: Stream.fromIterable(options.stderr ?? []),
      exitCode: Effect.succeed(options.exitCode ?? 0),
      writeStdin: () => Effect.void,
      closeStdin: () =>
        Effect.sync(() => {
          closes.count += 1
        }),
      kill: () => Effect.void,
    }
    return Effect.succeed(process)
  },
  readFile: () => Effect.die("tank not used by this test"),
  writeFile: () => Effect.die("tank not used by this test"),
  release: () => Effect.die("tank not used by this test"),
})

const task: ExecutorTask = Schema.decodeUnknownSync(ExecutorTaskSchema)({
  taskId: `task_${randomUUID()}`,
  botId: `bot_${randomUUID()}`,
  prompt: "reply with the single word pong",
  tier: "chat",
  allowedTools: ["Bash", "Write"],
  permissionMode: "edit",
  maxTurns: 4,
  budget: { tokens: 1000, seconds: 60, usd: 0.25 },
  resumeSessionId: "sess-prev",
})

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  botName: "lead",
  cwd: "/work/bot",
  home: "/work/bot/home",
  env: { HOME: "/work/bot/home", PATH: "/usr/bin" },
}

// Runs the executor against a fake Tank and collects every event (or the typed error).
const collect = (executor: ReturnType<typeof makeClaudeCode>, stdout: ReadonlyArray<string>) => {
  const calls: Array<SpawnCall> = []
  const closes = { count: 0 }
  const stream: Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =
    executor.run(task, ctx)
  return Stream.runCollect(stream).pipe(
    Effect.scoped,
    Effect.provideService(Tank, fakeTank(stdout, calls, closes)),
    Effect.map((events) => ({ events, calls, closes: closes.count })),
  )
}

// Like collect, with stderr lines and an exit code on the fake process.
const runWith = (
  executor: ReturnType<typeof makeClaudeCode>,
  stdout: ReadonlyArray<string>,
  options: FakeProcessOptions,
) => {
  const calls: Array<SpawnCall> = []
  return Stream.runCollect(executor.run(task, ctx)).pipe(
    Effect.scoped,
    Effect.provideService(Tank, fakeTank(stdout, calls, { count: 0 }, options)),
    Effect.map((events) => ({ events, calls })),
  )
}

describe("makeClaudeCode run", () => {
  it.effect("success fixture ends with usage then done carrying the session id from init", () =>
    Effect.gen(function* () {
      const { events } = yield* collect(makeClaudeCode(), fixture("success.ndjson"))
      const sessionId = "0f720204-b508-4ea0-b1cc-54b7be7ea626"
      expect(events[0]).toEqual({ kind: "started", sessionId, model: "claude-haiku-5-5" })
      expect(events.at(-2)).toMatchObject({ kind: "usage", usage: { tokensOut: 4 } })
      expect(events.at(-1)).toEqual({ kind: "done", result: "pong", artifacts: [], sessionId })
    }),
  )

  it.effect("max-turns fixture ends with error{max_turns}", () =>
    Effect.gen(function* () {
      const { events } = yield* collect(makeClaudeCode(), fixture("error-max-turns.ndjson"))
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "max_turns" })
      expect(events.at(-2)?.kind).toBe("usage")
    }),
  )

  it.effect("with-tools fixture yields at least one command and one file_edit", () =>
    Effect.gen(function* () {
      const { events } = yield* collect(makeClaudeCode(), fixture("with-tools.ndjson"))
      expect(events.some((event) => event.kind === "command")).toBe(true)
      expect(events.some((event) => event.kind === "file_edit")).toBe(true)
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "hi" })
    }),
  )

  it.effect(
    "spawns claude with the argv from buildArgs, merged env, and closes stdin right after spawn",
    () =>
      Effect.gen(function* () {
        const executor = makeClaudeCode({ envOverrides: { ANTHROPIC_BASE_URL: "https://example.test" } })
        const { calls, closes } = yield* collect(executor, fixture("success.ndjson"))
        expect(calls).toHaveLength(1)
        const [call] = calls
        expect(call?.cmd).toEqual(["claude", ...buildArgs(task, defaultMapTier)])
        expect(call?.ctx.env).toEqual({
          HOME: "/work/bot/home",
          PATH: "/usr/bin",
          ANTHROPIC_BASE_URL: "https://example.test",
        })
        expect(closes).toBe(1)
      }),
  )

  it.effect("a non-JSON stdout line fails the stream with ExecutorProtocolError", () =>
    Effect.gen(function* () {
      const error = yield* collect(makeClaudeCode(), ['{"type":"system","subtype":"init"}', "not json"]).pipe(
        Effect.flip,
      )
      expect(error).toBeInstanceOf(ExecutorProtocolError)
      expect(error.executor).toBe("claude-code")
    }),
  )

  it.effect("a failure to spawn the process surfaces as ExecutorSpawnError", () =>
    Effect.gen(function* () {
      const failing: TankShape = {
        ...fakeTank([], [], { count: 0 }),
        spawnStream: () => Effect.fail(new TankError({ op: "spawn", cause: "ENOENT" })),
      }
      const error = yield* Stream.runCollect(makeClaudeCode().run(task, ctx)).pipe(
        Effect.scoped,
        Effect.provideService(Tank, failing),
        Effect.flip,
      )
      expect(error).toBeInstanceOf(ExecutorSpawnError)
      expect(error.executor).toBe("claude-code")
    }),
  )
})

describe("makeClaudeCode mapTier", () => {
  const executor = makeClaudeCode()

  it.each([
    ["chat", { model: "claude-haiku-5-5", effort: "low" }],
    ["decision", { model: "claude-haiku-5-5", effort: "low" }],
    ["light", { model: "claude-haiku-5-5", effort: "high" }],
    ["heavy", { model: "claude-opus-5-5", effort: "high" }],
  ] as const)("maps tier %s to %j with a full model id, never an alias", (tier, expected) => {
    expect(executor.mapTier(tier)).toEqual(expected)
  })
})

describe("makeClaudeCode mcp", () => {
  const modelFlag = (argv: ReadonlyArray<string>) => argv[argv.indexOf("--model") + 1]

  it.effect("runs with the MCP connectors off by default", () =>
    Effect.gen(function* () {
      const { calls } = yield* collect(makeClaudeCode(), fixture("success.ndjson"))
      expect(calls[0]?.cmd).toContain("--strict-mcp-config")
      expect(calls[0]?.cmd.at(-2)).toBe("--")
    }),
  )

  it.effect("drops the MCP flags with mcp inherit (reserved for T-042)", () =>
    Effect.gen(function* () {
      const { calls } = yield* collect(makeClaudeCode({ mcp: "inherit" }), fixture("success.ndjson"))
      expect(calls[0]?.cmd).not.toContain("--strict-mcp-config")
      expect(calls[0]?.cmd).not.toContain("--mcp-config")
    }),
  )

  it.effect("passes the chat tier as the full model id on the wire, never the haiku alias", () =>
    Effect.gen(function* () {
      const { calls } = yield* collect(makeClaudeCode(), fixture("success.ndjson"))
      expect(modelFlag(calls[0]?.cmd ?? [])).toBe("claude-haiku-5-5")
    }),
  )
})

describe("makeClaudeCode auth and stderr", () => {
  it.effect(
    "a run whose result says not logged in ends with error{auth} from the not-logged-in fixture",
    () =>
      Effect.gen(function* () {
        const { events } = yield* collect(makeClaudeCode(), fixture("not-logged-in.ndjson"))
        expect(events.at(-1)).toEqual({ kind: "error", code: "auth", message: "claude CLI is not logged in" })
      }),
  )

  it.effect("an is_error not-logged-in fixture also ends with error{auth}", () =>
    Effect.gen(function* () {
      const { events } = yield* collect(makeClaudeCode(), fixture("not-logged-in-error.ndjson"))
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "auth" })
    }),
  )

  it.effect("a process that exits 1 without a result carries the redacted stderr tail", () =>
    Effect.gen(function* () {
      const stderr = [
        "Error: unknown option '--bogus'",
        "api token=abc123 leaked",
        "clone https://user:hunter2@example.test/repo",
      ]
      const { events } = yield* runWith(makeClaudeCode(), [], { stderr, exitCode: 1 })
      expect(events).toEqual([
        {
          kind: "error",
          code: "unknown",
          message: [
            "claude exited with code 1 without a result; stderr: Error: unknown option '--bogus'",
            "[redacted]",
            "clone https://***@example.test/repo",
          ].join("\n"),
        },
      ])
    }),
  )

  it.effect("a silent exit 0 without a result still reports the stderr tail", () =>
    Effect.gen(function* () {
      const { events } = yield* runWith(makeClaudeCode(), [], { stderr: ["warning: slow start"] })
      expect(events).toEqual([
        {
          kind: "error",
          code: "protocol",
          message: "claude ended without a result; stderr: warning: slow start",
        },
      ])
    }),
  )

  it.effect("a silent exit 0 with an empty stderr reports no tail", () =>
    Effect.gen(function* () {
      const { events } = yield* runWith(makeClaudeCode(), [], {})
      expect(events).toEqual([{ kind: "error", code: "protocol", message: "claude ended without a result" }])
    }),
  )

  it.effect("stderr output on a run that reaches its result is not reported", () =>
    Effect.gen(function* () {
      const { events } = yield* runWith(makeClaudeCode(), fixture("success.ndjson"), {
        stderr: ["no stdin data received in 3s"],
      })
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "pong" })
      expect(events.some((event) => event.kind === "error")).toBe(false)
    }),
  )
})

describe("makeClaudeCode env", () => {
  it.effect("never passes ANTHROPIC_API_KEY, neither from the Tank env nor from envOverrides", () =>
    Effect.gen(function* () {
      const executor = makeClaudeCode({ envOverrides: { ANTHROPIC_API_KEY: "from-override", KEEP: "1" } })
      const withKey: TankContext = { ...ctx, env: { HOME: "/work/bot/home", ANTHROPIC_API_KEY: "from-tank" } }
      const calls: Array<SpawnCall> = []
      yield* Stream.runCollect(executor.run(task, withKey)).pipe(
        Effect.scoped,
        Effect.provideService(Tank, fakeTank(fixture("success.ndjson"), calls, { count: 0 })),
      )
      expect(calls[0]?.ctx.env).toEqual({ HOME: "/work/bot/home", KEEP: "1" })
    }),
  )

  it.effect("keeps ANTHROPIC_AUTH_TOKEN from envOverrides, for gateways such as Z.ai", () =>
    Effect.gen(function* () {
      const executor = makeClaudeCode({ envOverrides: { ANTHROPIC_AUTH_TOKEN: "gateway-token" } })
      const { calls } = yield* collect(executor, fixture("success.ndjson"))
      expect(calls[0]?.ctx.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "gateway-token" })
    }),
  )
})

describe("makeClaudeCode through the registry", () => {
  it.effect("a stream cut before its result line ends with error{protocol}", () =>
    Effect.gen(function* () {
      const registry = yield* ExecutorRegistry
      const executor = yield* registry.get(makeClaudeCode().id)
      const truncated = fixture("success.ndjson").slice(0, -1)
      const events = yield* Stream.runCollect(executor.run(task, ctx)).pipe(
        Effect.scoped,
        Effect.provideService(Tank, fakeTank(truncated, [], { count: 0 })),
      )
      // The adapter reports the cut itself (with the stderr tail when there is one); the registry guard is the fallback.
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "protocol",
        message: "claude ended without a result",
      })
    }).pipe(Effect.provide(makeRegistry([makeClaudeCode()]))),
  )
})
