import { RequestError } from "@agentclientprotocol/sdk"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { startFakeAgent, text, update } from "./fake-agent.js"
import {
  collect,
  ctx,
  executorWith,
  fakePolicy,
  kinds,
  runAgent,
  sessionIdOf,
  tankServing,
  task,
} from "./harness.js"

const { policy } = fakePolicy({})

describe("acp run", () => {
  it.effect("handshake, prompt, updates and stop become started .. done", () =>
    Effect.gen(function* () {
      const { events, argvs, agent } = yield* runAgent(
        {
          onPrompt: async (call) => {
            await update(call, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "hmm" },
            })
            await update(call, text("po"))
            await update(call, text("ng"))
            await update(call, {
              sessionUpdate: "tool_call",
              toolCallId: "t1",
              title: "look",
              kind: "other",
              status: "pending",
            })
            await update(call, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })
            return {
              stopReason: "end_turn",
              usage: {
                totalTokens: 14,
                inputTokens: 10,
                outputTokens: 3,
                thoughtTokens: 1,
                cachedReadTokens: 2,
              },
            }
          },
        },
        policy,
      )
      expect(argvs).toEqual([["fake-acp", "--acp"]])
      expect(kinds(events)).toEqual([
        "started",
        "thinking",
        "text",
        "text",
        "tool_call",
        "tool_call",
        "usage",
        "done",
      ])
      expect(events[0]).toEqual({ kind: "started", sessionId: sessionIdOf("sess-1") })
      expect(events.at(-2)).toEqual({
        kind: "usage",
        usage: { tokensIn: 10, tokensOut: 4, cacheRead: 2, cacheWrite: 0, usd: 0, seconds: 0 },
      })
      expect(events.at(-1)).toEqual({
        kind: "done",
        result: "pong",
        artifacts: [],
        sessionId: sessionIdOf("sess-1"),
      })
      expect(agent.seen.map((s) => s.method)).toEqual(["initialize", "session/new", "session/prompt"])
      expect(agent.seen[0]?.params).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      })
      expect(agent.seen[1]?.params).toMatchObject({ cwd: ctx.cwd, mcpServers: [] })
      expect(agent.seen[2]?.params).toMatchObject({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "say pong" }],
      })
    }),
  )

  it.effect("the system append leads the first prompt", () =>
    Effect.gen(function* () {
      const { agent } = yield* runAgent(
        { onPrompt: async () => ({ stopReason: "end_turn" }) },
        policy,
        task({ systemAppend: "Be brief." }),
      )
      expect(agent.seen[2]?.params).toMatchObject({
        prompt: [{ type: "text", text: "Be brief.\n\nsay pong" }],
      })
    }),
  )

  it.effect("commands, edits and failed edits use the Executor event kinds", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        {
          onPrompt: async (call) => {
            await update(call, {
              sessionUpdate: "tool_call",
              toolCallId: "c1",
              title: "run tests",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "pnpm test" },
            })
            await update(call, {
              sessionUpdate: "tool_call_update",
              toolCallId: "c1",
              status: "completed",
              rawOutput: { exitCode: 0 },
              content: [{ type: "content", content: { type: "text", text: "ok" } }],
            })
            await update(call, {
              sessionUpdate: "tool_call",
              toolCallId: "e1",
              title: "edit a",
              kind: "edit",
              status: "completed",
              content: [{ type: "diff", path: "/w/a.ts", newText: "x" }],
            })
            await update(call, {
              sessionUpdate: "tool_call",
              toolCallId: "e2",
              title: "edit b",
              kind: "edit",
              status: "failed",
              locations: [{ path: "/w/b.ts" }],
            })
            return { stopReason: "end_turn" }
          },
        },
        policy,
      )
      expect(events.slice(1, -1)).toEqual([
        { kind: "command", cmd: "pnpm test", exitCode: 0, output: "ok" },
        { kind: "file_edit", path: "/w/a.ts" },
        { kind: "tool_call", call: { tool: "Edit", input: {}, resource: "/w/b.ts" }, status: "failed" },
      ])
    }),
  )

  it.effect("resume loads the session, drops its replayed history and prompts again", () =>
    Effect.gen(function* () {
      const { events, agent } = yield* runAgent(
        {
          replay: ["OLD HISTORY"],
          onPrompt: async (call) => {
            await update(call, text("continued"))
            return { stopReason: "end_turn" }
          },
        },
        policy,
        task({
          prompt: "APPROVED: proceed.",
          resumeSessionId: sessionIdOf("sess-9"),
          systemAppend: "ignored",
        }),
      )
      expect(kinds(events)).toEqual(["started", "text", "done"])
      expect(events[0]).toEqual({ kind: "started", sessionId: sessionIdOf("sess-9") })
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "continued" })
      expect(agent.seen.map((s) => s.method)).toEqual(["initialize", "session/load", "session/prompt"])
      expect(agent.seen[1]?.params).toMatchObject({ sessionId: "sess-9", cwd: ctx.cwd, mcpServers: [] })
      expect(agent.seen[2]?.params).toMatchObject({ prompt: [{ type: "text", text: "APPROVED: proceed." }] })
    }),
  )

  it.effect("resume against an agent without loadSession is a protocol error", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        { loadSession: false, onPrompt: async () => ({ stopReason: "end_turn" }) },
        policy,
        task({ resumeSessionId: sessionIdOf("sess-9") }),
      )
      expect(events).toEqual([
        { kind: "error", code: "protocol", message: "the agent cannot load sessions, so it cannot resume" },
      ])
    }),
  )

  it.effect("an authRequired answer is error auth", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        { newSessionError: RequestError.authRequired(), onPrompt: async () => ({ stopReason: "end_turn" }) },
        policy,
      )
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: "error", code: "auth" })
    }),
  )

  it.effect("a process that ends mid-turn is reported with its exit code", () =>
    Effect.gen(function* () {
      const exit: { current: Effect.Effect<void> } = { current: Effect.void }
      const agent = yield* startFakeAgent({
        onPrompt: () => Effect.runPromise(exit.current).then(() => new Promise<never>(() => undefined)),
      })
      exit.current = agent.proc.kill()
      const { shape } = tankServing(agent)
      const events = yield* collect(executorWith(policy), task(), shape)
      expect(kinds(events)).toEqual(["started", "error"])
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "unknown",
        message: "acp-fake exited with code 143 without a result",
      })
      expect(agent.state.killed).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("the wall-clock budget cuts a silent agent, reports budget and kills the group", () =>
    Effect.gen(function* () {
      const promptSeen = yield* Deferred.make<void>()
      const agent = yield* startFakeAgent({
        onPrompt: () => {
          Deferred.doneUnsafe(promptSeen, Effect.void)
          return new Promise<never>(() => undefined)
        },
      })
      const { shape } = tankServing(agent)
      const fiber = yield* Effect.forkChild(
        collect(executorWith(policy), task({ budget: { tokens: 1000, seconds: 5, usd: 1 } }), shape),
      )
      yield* Deferred.await(promptSeen)
      yield* TestClock.adjust("6 seconds")
      const events = yield* Fiber.join(fiber)
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "budget",
        message: "wall-clock budget of 5s exceeded",
      })
      expect(agent.state.killed).toBeGreaterThanOrEqual(1)
    }),
  )
})
