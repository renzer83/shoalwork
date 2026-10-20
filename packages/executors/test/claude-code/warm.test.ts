import { randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
  TankError,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { type Cause, Effect, Exit, Layer, Queue, Schema, Scope, Stream } from "effect"
import { describe, expect } from "vitest"
import { buildWarmChatArgs, encodeWarmUserMessage } from "../../src/claude-code/args.js"
import { makeClaudeCodeChat, runChatTurn } from "../../src/claude-code/chat.js"
import { ChatSessions, ChatSessionsLive } from "../../src/claude-code/sessions.js"
import { makeWarmChatPool, type WarmChatPool, type WarmChatPoolOptions } from "../../src/claude-code/warm.js"

const SESSION_A = "40e66dbf-beaf-4fc5-839d-ea3f883591f6"
const SESSION_B = "5b1f0c2e-0d4a-4e8c-9a51-2c7d6e9f1a20"
const FRESH_SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

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

const initLine = (sessionId: string): string =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-haiku-5-5" })

const resultLine = (sessionId: string, result: string): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
    total_cost_usd: 0.001,
    duration_ms: 900,
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
  })

// What the fake process prints for one stdin message.
type Reply =
  | { readonly lines: ReadonlyArray<string>; readonly delayMs?: number; readonly exitAfter?: boolean }
  | "die" // stdout closes without a result
  | "hang" // never answers

const answer = (sessionId: string, text: string, delayMs?: number): Reply => ({
  lines: [
    initLine(sessionId),
    JSON.stringify({ type: "rate_limit_event" }),
    "not json, ignored",
    resultLine(sessionId, text),
  ],
  ...(delayMs !== undefined ? { delayMs } : {}),
})

type Script =
  // A long-lived process: each stdin line is answered by `reply(prompt, index)`.
  | { readonly reply: (prompt: string, index: number) => Reply }
  // A one-shot process (the fallback): prints these lines and closes stdout at once.
  | { readonly stdout: ReadonlyArray<string> }
  | { readonly spawnFails: true }
  // A one-shot process that never prints and never ends.
  | { readonly hang: true }

type Recorder = {
  readonly argv: Array<ReadonlyArray<string>>
  readonly envs: Array<Readonly<Record<string, string>>>
  readonly stdin: Array<Array<string>>
  // Per spawn: true once its scope closed (the process group would have been stopped).
  readonly closed: Array<boolean>
}

const emptyRecorder = (): Recorder => ({ argv: [], envs: [], stdin: [], closed: [] })

const fakeTank = (scripts: Array<Script>, rec: Recorder): TankShape => ({
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: (spawnCtx, cmd): Effect.Effect<RunningProcess, TankError, Scope.Scope> =>
    Effect.gen(function* () {
      const script = scripts.shift()
      if (script === undefined) return yield* Effect.die("no script left for this spawn")
      if ("spawnFails" in script) return yield* Effect.fail(new TankError({ op: "spawn", cause: "boom" }))
      const index = rec.argv.length
      rec.argv.push(cmd)
      rec.envs.push(spawnCtx.env)
      rec.stdin.push([])
      rec.closed.push(false)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rec.closed[index] = true
        }),
      )
      const out = yield* Queue.unbounded<string, Cause.Done>()
      let messages = 0
      if ("stdout" in script) {
        for (const line of script.stdout) Queue.offerUnsafe(out, line)
        Queue.endUnsafe(out)
      }
      const proc: RunningProcess = {
        pid: 1,
        stdout: Stream.fromQueue(out),
        stderr: Stream.empty,
        exitCode: Effect.succeed(0),
        writeStdin: (text) =>
          Effect.sync(() => {
            rec.stdin[index]?.push(text)
            if (!("reply" in script)) return
            const parsed: unknown = JSON.parse(text)
            const prompt =
              typeof parsed === "object" && parsed !== null && "message" in parsed
                ? String((parsed.message as { content: unknown }).content)
                : ""
            const reply = script.reply(prompt, messages)
            messages += 1
            if (reply === "hang") return
            if (reply === "die") {
              Queue.endUnsafe(out)
              return
            }
            const emit = () => {
              for (const line of reply.lines) Queue.offerUnsafe(out, line)
              if (reply.exitAfter === true) Queue.endUnsafe(out)
            }
            if (reply.delayMs === undefined) emit()
            else setTimeout(emit, reply.delayMs)
          }),
        closeStdin: () => ("hang" in script ? Effect.void : Effect.sync(() => void Queue.endUnsafe(out))),
        kill: () => Effect.void,
      }
      return proc
    }),
  readFile: () => Effect.die("tank not used by this test"),
  writeFile: () => Effect.die("tank not used by this test"),
  worktrees: () => Effect.die("tank not used by this test"),
  removeWorktree: () => Effect.die("tank not used by this test"),
  release: () => Effect.die("tank not used by this test"),
})

// An echo process: answers every message with the same session.
const echo = (sessionId: string): Script => ({ reply: (prompt) => answer(sessionId, `echo:${prompt}`) })

const doneOf = (events: ReadonlyArray<ExecutorEvent>) => events.find((event) => event.kind === "done")

const withPool = <A, E, R>(
  scripts: Array<Script>,
  rec: Recorder,
  opts: WarmChatPoolOptions,
  body: (pool: WarmChatPool) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* makeWarmChatPool(opts)
      return yield* body(pool)
    }),
  ).pipe(Effect.provideService(Tank, fakeTank(scripts, rec)))

describe("buildWarmChatArgs", () => {
  it("builds the warm argv: stream-json in and out, chat flags, no prompt and no separator", () => {
    expect(buildWarmChatArgs(chatTask())).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-haiku-5-5",
      "--effort",
      "low",
      "--tools",
      "",
      "--permission-mode",
      "plan",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ])
  })

  it("adds --resume and --append-system-prompt and never the prompt text", () => {
    const args = buildWarmChatArgs(
      chatTask({ resumeSessionId: SESSION_A, systemAppend: "Be brief.", prompt: "secret question" }),
    )
    expect(args.slice(-4)).toEqual(["--resume", SESSION_A, "--append-system-prompt", "Be brief."])
    expect(args).not.toContain("--")
    expect(args).not.toContain("secret question")
  })
})

describe("encodeWarmUserMessage", () => {
  it("encodes one stream-json user line ending in a newline", () => {
    const line = encodeWarmUserMessage("hello")
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: "hello" } })
  })

  it("keeps text that looks like a flag, newlines and line separators on one line", () => {
    const separators = String.fromCharCode(0x2028, 0x2029)
    const text = `--permission-mode=bypassPermissions\nsecond${separators}third`
    const line = encodeWarmUserMessage(text)
    const body = line.slice(0, -1)
    expect(
      body.includes("\n") || body.includes(separators[0] ?? "") || body.includes(separators[1] ?? ""),
    ).toBe(false)
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: text } })
  })
})

describe("WarmChatPool", () => {
  it.live("serves three messages of one scope with one spawn, writing the text only to stdin", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const prompts = ["one", "--permission-mode=bypassPermissions", "three"]
      const outcomes = yield* withPool([echo(SESSION_A)], rec, {}, (pool) =>
        Effect.forEach(prompts, (prompt) => pool.turn("scope-a", chatTask({ prompt }), ctx)),
      )
      expect(rec.argv).toHaveLength(1)
      expect(rec.argv[0]).toEqual(["claude", ...buildWarmChatArgs(chatTask())])
      expect(rec.argv[0]?.some((arg) => prompts.includes(arg))).toBe(false)
      expect(rec.stdin[0]?.map((line) => JSON.parse(line).message.content)).toEqual(prompts)
      expect(rec.envs[0]).not.toHaveProperty("ANTHROPIC_API_KEY")
      expect(rec.envs[0]?.HOME).toBe("/work/bot/home")
      outcomes.forEach((outcome, i) => {
        expect(outcome.kind).toBe("events")
        const events = outcome.kind === "events" ? outcome.events : []
        expect(events.map((event) => event.kind)).toEqual(["started", "usage", "done"])
        expect(doneOf(events)).toEqual({
          kind: "done",
          result: `echo:${prompts[i]}`,
          artifacts: [],
          sessionId: SESSION_A,
        })
      })
      // Closing the pool scope stopped the process.
      expect(rec.closed).toEqual([true])
    }),
  )

  it.live("spawns one process per scope", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const size = yield* withPool([echo(SESSION_A), echo(SESSION_B)], rec, {}, (pool) =>
        Effect.gen(function* () {
          yield* pool.turn("scope-a", chatTask(), ctx)
          yield* pool.turn("scope-b", chatTask(), ctx)
          yield* pool.turn("scope-a", chatTask(), ctx)
          return yield* pool.size
        }),
      )
      expect(size).toBe(2)
      expect(rec.argv).toHaveLength(2)
      expect(rec.stdin.map((lines) => lines.length)).toEqual([2, 1])
    }),
  )

  it.live("starts the process with --resume when the task carries the stored session", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* withPool([echo(SESSION_A)], rec, {}, (pool) =>
        pool.turn("scope-a", chatTask({ resumeSessionId: SESSION_A }), ctx),
      )
      const args = rec.argv[0] ?? []
      expect(args[args.indexOf("--resume") + 1]).toBe(SESSION_A)
    }),
  )

  it.live("stops a process after it was idle for idleMs and spawns a new one for the next message", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* withPool([echo(SESSION_A), echo(SESSION_A)], rec, { idleMs: 60, sweepMs: 10 }, (pool) =>
        Effect.gen(function* () {
          yield* pool.turn("scope-a", chatTask(), ctx)
          expect(yield* pool.size).toBe(1)
          yield* Effect.sleep(400)
          expect(yield* pool.size).toBe(0)
          expect(rec.closed).toEqual([true])
          const again = yield* pool.turn("scope-a", chatTask(), ctx)
          expect(again.kind).toBe("events")
          expect(rec.argv).toHaveLength(2)
        }),
      )
    }),
  )

  it.live("keeps a process that is used more often than idleMs", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* withPool([echo(SESSION_A)], rec, { idleMs: 150, sweepMs: 10 }, (pool) =>
        Effect.gen(function* () {
          for (let i = 0; i < 5; i++) {
            yield* pool.turn("scope-a", chatTask(), ctx)
            yield* Effect.sleep(50)
          }
          expect(rec.argv).toHaveLength(1)
          expect(rec.closed).toEqual([false])
        }),
      )
    }),
  )

  it.live("respects maxProcesses by stopping the oldest idle process", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* withPool(
        [echo(SESSION_A), echo(SESSION_B), echo(FRESH_SESSION)],
        rec,
        { maxProcesses: 2 },
        (pool) =>
          Effect.gen(function* () {
            yield* pool.turn("scope-a", chatTask(), ctx)
            yield* Effect.sleep(5)
            yield* pool.turn("scope-b", chatTask(), ctx)
            yield* Effect.sleep(5)
            // Touch a so that b is the oldest idle one.
            yield* pool.turn("scope-a", chatTask(), ctx)
            yield* Effect.sleep(5)
            const third = yield* pool.turn("scope-c", chatTask(), ctx)
            expect(third.kind).toBe("events")
            expect(yield* pool.size).toBe(2)
            expect(rec.closed).toEqual([false, true, false])
          }),
      )
    }),
  )

  it.live("reports unavailable when the pool is full of busy processes", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const slow: Script = { reply: () => answer(SESSION_A, "slow", 150) }
      const [first, second] = yield* withPool([slow], rec, { maxProcesses: 1 }, (pool) =>
        Effect.all(
          [
            pool.turn("scope-a", chatTask(), ctx),
            Effect.sleep(30).pipe(Effect.andThen(pool.turn("scope-b", chatTask(), ctx))),
          ],
          { concurrency: 2 },
        ),
      )
      expect(first?.kind).toBe("events")
      expect(second).toEqual({ kind: "unavailable" })
      expect(rec.argv).toHaveLength(1)
    }),
  )

  it.live("serializes turns of one scope on its single process", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const seen: Array<string> = []
      const script: Script = {
        reply: (prompt) => {
          seen.push(prompt)
          return answer(SESSION_A, prompt, 60)
        },
      }
      const outcomes = yield* withPool([script], rec, {}, (pool) =>
        Effect.all(
          ["first", "second", "third"].map((prompt) => pool.turn("scope-a", chatTask({ prompt }), ctx)),
          { concurrency: 3 },
        ),
      )
      // Each answer carries its own prompt: no turn read the result of another.
      expect(outcomes.map((o) => (o.kind === "events" ? doneOf(o.events) : undefined))).toMatchObject([
        { result: "first" },
        { result: "second" },
        { result: "third" },
      ])
      expect(rec.argv).toHaveLength(1)
    }),
  )

  it.live("reports unavailable and drops the process when it dies in the middle of a turn", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const script: Script = {
        reply: (prompt, index) => (index === 0 ? answer(SESSION_A, prompt) : "die"),
      }
      const [ok, dead, size] = yield* withPool([script], rec, {}, (pool) =>
        Effect.gen(function* () {
          const a = yield* pool.turn("scope-a", chatTask(), ctx)
          const b = yield* pool.turn("scope-a", chatTask(), ctx)
          return [a, b, yield* pool.size] as const
        }),
      )
      expect(ok.kind).toBe("events")
      expect(dead).toEqual({ kind: "unavailable" })
      expect(size).toBe(0)
      expect(rec.closed).toEqual([true])
    }),
  )

  it.live("starts a new process when the previous one died while idle", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const mortal: Script = {
        reply: (prompt) => ({
          lines: [initLine(SESSION_A), resultLine(SESSION_A, prompt)],
          exitAfter: true,
        }),
      }
      const [first, second] = yield* withPool([mortal, echo(SESSION_B)], rec, {}, (pool) =>
        Effect.gen(function* () {
          const a = yield* pool.turn("scope-a", chatTask(), ctx)
          yield* Effect.sleep(30)
          const b = yield* pool.turn("scope-a", chatTask({ resumeSessionId: SESSION_A }), ctx)
          return [a, b] as const
        }),
      )
      expect(first.kind).toBe("events")
      expect(second.kind === "events" ? doneOf(second.events) : undefined).toMatchObject({
        sessionId: SESSION_B,
      })
      expect(rec.argv).toHaveLength(2)
      expect(rec.closed[0]).toBe(true)
      const respawn = rec.argv[1] ?? []
      expect(respawn[respawn.indexOf("--resume") + 1]).toBe(SESSION_A)
    }),
  )

  it.live("times out a turn that never answers and stops that process", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const outcome = yield* withPool([{ reply: () => "hang" }], rec, { timeoutMs: 80 }, (pool) =>
        pool.turn("scope-a", chatTask(), ctx),
      )
      expect(outcome).toEqual({ kind: "timeout", timeoutMs: 80 })
      expect(rec.closed).toEqual([true])
    }),
  )

  it.live("reports unavailable when the spawn fails", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const [outcome, size] = yield* withPool([{ spawnFails: true }], rec, {}, (pool) =>
        Effect.all([pool.turn("scope-a", chatTask(), ctx), pool.size]),
      )
      expect(outcome).toEqual({ kind: "unavailable" })
      expect(size).toBe(0)
    }),
  )

  it.live("discards the process of an interrupted turn so the next turn gets its own answer", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      // The first process answers late: its result for "slow" arrives after the turn was given up.
      const late: Script = { reply: (prompt) => answer(SESSION_A, `late:${prompt}`, 300) }
      const [interrupted, next] = yield* withPool([late, echo(SESSION_B)], rec, {}, (pool) =>
        Effect.gen(function* () {
          const first = yield* pool
            .turn("scope-a", chatTask({ prompt: "slow" }), ctx)
            .pipe(Effect.timeoutOption(60))
          const second = yield* pool.turn("scope-a", chatTask({ prompt: "second" }), ctx)
          yield* Effect.sleep(400)
          return [first, second] as const
        }),
      )
      expect(interrupted._tag).toBe("None")
      expect(next.kind === "events" ? doneOf(next.events) : undefined).toMatchObject({
        result: "echo:second",
        sessionId: SESSION_B,
      })
      expect(rec.argv).toHaveLength(2)
      expect(rec.closed[0]).toBe(true)
    }),
  )

  it.live("does not stop a process that is busy for longer than idleMs", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const slow: Script = { reply: (prompt) => answer(SESSION_A, prompt, 250) }
      const outcome = yield* withPool([slow], rec, { idleMs: 40, sweepMs: 10 }, (pool) =>
        pool.turn("scope-a", chatTask({ prompt: "busy" }), ctx),
      )
      expect(outcome.kind === "events" ? doneOf(outcome.events) : undefined).toMatchObject({ result: "busy" })
      expect(rec.argv).toHaveLength(1)
    }),
  )

  it.live("answers unavailable after the pool closed and spawns nothing", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const tank = fakeTank([echo(SESSION_A)], rec)
      const poolScope = yield* Scope.make()
      const pool = yield* makeWarmChatPool().pipe(Scope.provide(poolScope), Effect.provideService(Tank, tank))
      yield* Scope.close(poolScope, Exit.void)
      const outcome = yield* pool.turn("scope-a", chatTask(), ctx)
      expect(outcome).toEqual({ kind: "unavailable" })
      expect(rec.argv).toHaveLength(0)
    }),
  )

  it.live("does not hand a late line after the result to the next turn", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const script: Script = {
        reply: (prompt, index) =>
          index === 0
            ? {
                lines: [
                  initLine(SESSION_A),
                  resultLine(SESSION_A, prompt),
                  JSON.stringify({
                    type: "assistant",
                    message: { content: [{ type: "text", text: "stale" }] },
                  }),
                  resultLine(SESSION_A, "stale result"),
                ],
              }
            : answer(SESSION_A, prompt),
      }
      const [first, second] = yield* withPool([script], rec, {}, (pool) =>
        Effect.gen(function* () {
          const a = yield* pool.turn("scope-a", chatTask({ prompt: "one" }), ctx)
          const b = yield* pool.turn("scope-a", chatTask({ prompt: "two" }), ctx)
          return [a, b] as const
        }),
      )
      expect(first.kind === "events" ? doneOf(first.events) : undefined).toMatchObject({ result: "one" })
      expect(second.kind === "events" ? doneOf(second.events) : undefined).toMatchObject({ result: "two" })
      expect(JSON.stringify(second)).not.toContain("stale")
      expect(rec.argv).toHaveLength(1)
    }),
  )

  it.live("reports unavailable when a line has the right type but an invalid field", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const bad: Script = {
        reply: () => ({ lines: [JSON.stringify({ type: "assistant", message: { content: 42 } })] }),
      }
      const outcome = yield* withPool([bad], rec, {}, (pool) => pool.turn("scope-a", chatTask(), ctx))
      expect(outcome).toEqual({ kind: "unavailable" })
      expect(rec.closed).toEqual([true])
    }),
  )

  it.live("keeps turns of one key serialized when the process dies and is replaced", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const dies: Script = { reply: () => "die" }
      const [first, second] = yield* withPool([dies, echo(SESSION_B)], rec, {}, (pool) =>
        Effect.all(
          [
            pool.turn("scope-a", chatTask({ prompt: "first" }), ctx),
            pool.turn("scope-a", chatTask({ prompt: "second" }), ctx),
          ],
          { concurrency: 2 },
        ),
      )
      expect(first).toEqual({ kind: "unavailable" })
      expect(second.kind === "events" ? doneOf(second.events) : undefined).toMatchObject({
        result: "echo:second",
      })
      expect(rec.stdin[0]).toHaveLength(1)
      expect(rec.stdin[1]).toHaveLength(1)
    }),
  )

  it.live("stops every process when the pool scope closes", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      yield* withPool([echo(SESSION_A), echo(SESSION_B), echo(FRESH_SESSION)], rec, {}, (pool) =>
        Effect.gen(function* () {
          yield* pool.turn("scope-a", chatTask(), ctx)
          yield* pool.turn("scope-b", chatTask(), ctx)
          yield* pool.turn("scope-c", chatTask(), ctx)
          expect(rec.closed).toEqual([false, false, false])
        }),
      )
      expect(rec.closed).toEqual([true, true, true])
    }),
  )
})

describe("runChatTurn with a warm pool", () => {
  const SessionsLayer = Layer.provideMerge(ChatSessionsLive, withTempDb())

  const oneShotResult = (sessionId: string, text: string): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      session_id: sessionId,
      total_cost_usd: 0.001,
      duration_ms: 1200,
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5,
      },
    })

  it.live("answers through the warm process and stores its session", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const executor = makeClaudeCodeChat()
      const sessions = yield* ChatSessions
      const events = yield* withPool([echo(SESSION_A)], rec, {}, (warm) =>
        Effect.gen(function* () {
          yield* Stream.runCollect(runChatTurn(executor, "tg:1:1", chatTask(), ctx, { warm })).pipe(
            Effect.scoped,
          )
          return yield* Stream.runCollect(
            runChatTurn(executor, "tg:1:1", chatTask({ prompt: "again" }), ctx, { warm }),
          ).pipe(Effect.scoped)
        }),
      )
      expect(doneOf(events)).toMatchObject({ result: "echo:again", sessionId: SESSION_A })
      expect(rec.argv).toHaveLength(1)
      expect(rec.argv[0]).toContain("--input-format")
      const stored = yield* sessions.get("tg:1:1")
      expect(stored._tag === "Some" ? stored.value : undefined).toBe(SESSION_A)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("falls back to the one-shot chat with --resume of the stored session when the process dies", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const executor = makeClaudeCodeChat()
      const sessions = yield* ChatSessions
      const warmScript: Script = {
        reply: (prompt, index) => (index === 0 ? answer(SESSION_A, prompt) : "die"),
      }
      const events = yield* withPool(
        [warmScript, { stdout: [oneShotResult(SESSION_A, "pong from one-shot")] }],
        rec,
        {},
        (warm) =>
          Effect.gen(function* () {
            yield* Stream.runCollect(runChatTurn(executor, "tg:1:2", chatTask(), ctx, { warm })).pipe(
              Effect.scoped,
            )
            return yield* Stream.runCollect(
              runChatTurn(executor, "tg:1:2", chatTask({ prompt: "second" }), ctx, { warm }),
            ).pipe(Effect.scoped)
          }),
      )
      expect(doneOf(events)).toMatchObject({ result: "pong from one-shot", sessionId: SESSION_A })
      expect(rec.argv).toHaveLength(2)
      const fallback = rec.argv[1] ?? []
      expect(fallback).toContain("json")
      expect(fallback[fallback.indexOf("--resume") + 1]).toBe(SESSION_A)
      expect(fallback.at(-1)).toBe("second")
      expect(rec.closed[0]).toBe(true)
      const stored = yield* sessions.get("tg:1:2")
      expect(stored._tag === "Some" ? stored.value : undefined).toBe(SESSION_A)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("reports the timeout as an error event and does not fall back", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* withPool([{ reply: () => "hang" }], rec, { timeoutMs: 60 }, (warm) =>
        Stream.runCollect(runChatTurn(makeClaudeCodeChat(), "tg:1:3", chatTask(), ctx, { warm })).pipe(
          Effect.scoped,
        ),
      )
      expect(events).toEqual([{ kind: "error", code: "unknown", message: "chat turn exceeded 60 ms" }])
      expect(rec.argv).toHaveLength(1)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("gives the one-shot fallback only what is left of the single turn budget", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const warmScript: Script = { reply: () => "die" }
      const started = Date.now()
      const events = yield* withPool([warmScript, { hang: true }], rec, { timeoutMs: 120 }, (warm) =>
        Stream.runCollect(runChatTurn(makeClaudeCodeChat(), "tg:1:6", chatTask(), ctx, { warm })).pipe(
          Effect.scoped,
        ),
      )
      expect(events).toEqual([{ kind: "error", code: "unknown", message: "chat turn exceeded 120 ms" }])
      expect(Date.now() - started).toBeLessThan(1000)
      expect(rec.argv).toHaveLength(2)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("never uses the pool for tiers the chat does not serve", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* withPool([], rec, {}, (warm) =>
        Stream.runCollect(
          runChatTurn(makeClaudeCodeChat(), "tg:1:4", chatTask({ tier: "heavy" }), ctx, { warm }),
        ).pipe(Effect.scoped),
      )
      expect(events).toEqual([{ kind: "error", code: "unknown", message: "tier not supported by chat mode" }])
      expect(rec.argv).toHaveLength(0)
    }).pipe(Effect.provide(SessionsLayer)),
  )

  it.live("without a pool behaves as before (one-shot only)", () =>
    Effect.gen(function* () {
      const rec = emptyRecorder()
      const events = yield* Stream.runCollect(
        runChatTurn(makeClaudeCodeChat(), "tg:1:5", chatTask(), ctx),
      ).pipe(
        Effect.scoped,
        Effect.provideService(Tank, fakeTank([{ stdout: [oneShotResult(SESSION_B, "pong")] }], rec)),
      )
      expect(doneOf(events)).toMatchObject({ result: "pong", sessionId: SESSION_B })
      expect(rec.argv[0]).not.toContain("--input-format")
    }).pipe(Effect.provide(SessionsLayer)),
  )
})
