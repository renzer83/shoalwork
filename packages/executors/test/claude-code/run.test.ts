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

// A Tank whose spawnStream replays the given stdout lines. Records the spawn and the stdin closes.
const fakeTank = (
  stdout: ReadonlyArray<string>,
  calls: Array<SpawnCall>,
  closes: { count: number },
): TankShape => ({
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: (ctx, cmd) => {
    calls.push({ ctx, cmd })
    const process: RunningProcess = {
      pid: 1,
      stdout: Stream.fromIterable(stdout),
      stderr: Stream.empty,
      exitCode: Effect.succeed(0),
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
    ["chat", { model: "haiku", effort: "low" }],
    ["decision", { model: "haiku", effort: "low" }],
    ["light", { model: "haiku", effort: "high" }],
    ["heavy", { model: "opus", effort: "high" }],
  ] as const)("maps tier %s to %j", (tier, expected) => {
    expect(executor.mapTier(tier)).toEqual(expected)
  })
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
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "protocol",
        message: "executor stream ended without a terminal event",
      })
    }).pipe(Effect.provide(makeRegistry([makeClaudeCode()]))),
  )
})
