import { it } from "@effect/vitest"
import { type ExecutorEvent, ExecutorProtocolError } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "../../src/claude-code/events.js"

const decodeLine = Schema.decodeUnknownSync(ClaudeStreamLine)

// Maps raw JSON lines in order with one shared state, as a single run would.
const mapLines = (...raw: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const state = makeMapperState("claude-code")
    const events: Array<ExecutorEvent> = []
    for (const line of raw) {
      events.push(...(yield* toExecutorEvents(decodeLine(line), state)))
    }
    return events
  })

const init = {
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  model: "claude-haiku-5-5",
  tools: ["Bash"],
}
const assistant = (content: ReadonlyArray<unknown>) => ({
  type: "assistant",
  session_id: "sess-1",
  message: { model: "claude-haiku-5-5", role: "assistant", content, usage: { input_tokens: 2 } },
  parent_tool_use_id: null,
})
const userResult = (content: ReadonlyArray<unknown>) => ({
  type: "user",
  session_id: "sess-1",
  message: { role: "user", content },
  parent_tool_use_id: null,
})
const result = (overrides: Readonly<Record<string, unknown>>) => ({
  type: "result",
  session_id: "sess-1",
  duration_ms: 1500,
  total_cost_usd: 0.004,
  usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 11, cache_creation_input_tokens: 19 },
  ...overrides,
})

describe("toExecutorEvents", () => {
  it.effect("maps system/init to started with the session id and model", () =>
    Effect.gen(function* () {
      expect(yield* mapLines(init)).toEqual([
        { kind: "started", sessionId: "sess-1", model: "claude-haiku-5-5" },
      ])
    }),
  )

  it.effect("ignores other system subtypes", () =>
    Effect.gen(function* () {
      expect(yield* mapLines({ type: "system", subtype: "api_retry", attempt: 1 })).toEqual([])
    }),
  )

  it.effect("maps assistant text blocks to text events", () =>
    Effect.gen(function* () {
      expect(yield* mapLines(assistant([{ type: "text", text: "pong" }]))).toEqual([
        { kind: "text", text: "pong" },
      ])
    }),
  )

  it.effect("maps a Bash tool_use to a started tool_call plus a command event", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        assistant([
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la", description: "x" } },
        ]),
      )
      expect(events).toEqual([
        {
          kind: "tool_call",
          call: { tool: "Bash", input: { command: "ls -la", description: "x" } },
          status: "started",
        },
        { kind: "command", cmd: "ls -la" },
      ])
    }),
  )

  it.effect.each(["Edit", "Write", "MultiEdit"])(
    "maps a %s tool_use to a file_edit event with its path",
    (tool) =>
      Effect.gen(function* () {
        const events = yield* mapLines(
          assistant([
            { type: "tool_use", id: "toolu_2", name: tool, input: { file_path: "/work/a.ts", content: "x" } },
          ]),
        )
        expect(events).toContainEqual({ kind: "file_edit", path: "/work/a.ts" })
      }),
  )

  it.effect("does not emit file_edit for read-only tools", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        assistant([{ type: "tool_use", id: "toolu_3", name: "Read", input: { file_path: "/a" } }]),
      )
      expect(events.map((event) => event.kind)).toEqual(["tool_call"])
    }),
  )

  it.effect("maps tool_result to completed or failed, with the tool name taken from its tool_use", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        assistant([{ type: "tool_use", id: "toolu_4", name: "Bash", input: { command: "false" } }]),
        userResult([{ type: "tool_result", tool_use_id: "toolu_4", content: "boom", is_error: true }]),
        assistant([{ type: "tool_use", id: "toolu_5", name: "Bash", input: { command: "true" } }]),
        userResult([{ type: "tool_result", tool_use_id: "toolu_5", content: "", is_error: false }]),
      )
      const statuses = events.flatMap((event) =>
        event.kind === "tool_call" && event.status !== "started" ? [[event.call.tool, event.status]] : [],
      )
      expect(statuses).toEqual([
        ["Bash", "failed"],
        ["Bash", "completed"],
      ])
    }),
  )

  it.effect("maps a tool_result with an unknown tool_use_id to a tool_call named unknown", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        userResult([{ type: "tool_result", tool_use_id: "toolu_missing", content: "x" }]),
      )
      expect(events).toEqual([
        { kind: "tool_call", call: { tool: "unknown", input: undefined }, status: "completed" },
      ])
    }),
  )

  it.effect("maps a result success to usage followed by done with the session id", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        init,
        result({ subtype: "success", is_error: false, result: "pong", num_turns: 1 }),
      )
      expect(events.slice(-2)).toEqual([
        {
          kind: "usage",
          usage: { tokensIn: 2, tokensOut: 4, cacheRead: 11, cacheWrite: 19, usd: 0.004, seconds: 2 },
        },
        { kind: "done", result: "pong", artifacts: [], sessionId: "sess-1" },
      ])
    }),
  )

  it.effect("takes the done session id from init when the result line has no session_id", () =>
    Effect.gen(function* () {
      const bare = { type: "result", subtype: "success", is_error: false, result: "pong", duration_ms: 1 }
      const events = yield* mapLines(init, bare)
      expect(events.at(-1)).toEqual({ kind: "done", result: "pong", artifacts: [], sessionId: "sess-1" })
    }),
  )

  it.effect("leaves done without sessionId when neither init nor result carry one", () =>
    Effect.gen(function* () {
      const bare = { type: "result", subtype: "success", is_error: false, result: "pong" }
      const events = yield* mapLines(bare)
      expect(events.at(-1)).toEqual({ kind: "done", result: "pong", artifacts: [] })
    }),
  )

  it.effect("maps error_max_turns to usage followed by error{max_turns}", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        result({
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Reached maximum number of turns (1)"],
        }),
      )
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "max_turns",
        message: "Reached maximum number of turns (1)",
      })
      expect(events.at(-2)?.kind).toBe("usage")
    }),
  )

  it.effect("maps error_max_budget_usd to error{budget}, and any other error subtype to error{unknown}", () =>
    Effect.gen(function* () {
      const budget = yield* mapLines(
        result({ subtype: "error_max_budget_usd", is_error: true, errors: ["budget"] }),
      )
      expect(budget.at(-1)).toMatchObject({ kind: "error", code: "budget" })
      const other = yield* mapLines(
        result({ subtype: "error_during_execution", is_error: true, errors: ["crash"] }),
      )
      expect(other.at(-1)).toMatchObject({ kind: "error", code: "unknown", message: "crash" })
    }),
  )

  it.effect("maps an is_error result that says not logged in to error{auth}", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        result({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
      )
      expect(events.at(-1)).toEqual({ kind: "error", code: "auth", message: "claude CLI is not logged in" })
    }),
  )

  it.effect("maps an is_error result whose error text names authentication to error{auth}", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        result({ subtype: "error_during_execution", is_error: true, errors: ["authentication_error: 401"] }),
      )
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "auth" })
    }),
  )

  it.effect("maps a success result that is not logged in (is_error false, CLI 2.1.304) to error{auth}", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        result({ subtype: "success", is_error: false, result: "Not logged in · Please run /login" }),
      )
      expect(events.at(-1)).toEqual({ kind: "error", code: "auth", message: "claude CLI is not logged in" })
    }),
  )

  it.effect("keeps a successful answer that only mentions authentication as done", () =>
    Effect.gen(function* () {
      const events = yield* mapLines(
        result({ subtype: "success", is_error: false, result: "Use OAuth authentication for the API." }),
      )
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "Use OAuth authentication for the API." })
    }),
  )

  it.effect("ignores unknown line types such as rate_limit_event without failing", () =>
    Effect.gen(function* () {
      expect(
        yield* mapLines({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
          session_id: "sess-1",
        }),
      ).toEqual([])
    }),
  )

  it.effect("ignores an unknown line type even when one of its fields has the wrong shape", () =>
    Effect.gen(function* () {
      expect(yield* mapLines({ type: "rate_limit_event", usage: "x", session_id: 42, errors: 7 })).toEqual([])
    }),
  )

  it.effect("fails with ExecutorProtocolError when a mapped line type has a field of the wrong shape", () =>
    Effect.gen(function* () {
      const error = yield* mapLines({ type: "result", subtype: "success", usage: "x" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ExecutorProtocolError)
      expect(error.executor).toBe("claude-code")
    }),
  )
})

describe("ClaudeStreamLine", () => {
  it("accepts lines with extra fields and unknown types", () => {
    expect(decodeLine({ type: "stream_event", event: { anything: true }, uuid: "u" })).toMatchObject({
      type: "stream_event",
    })
  })

  it("keeps the extra fields of a line, so per-type decoding can read them", () => {
    expect(decodeLine({ type: "result", subtype: "success" })).toMatchObject({ subtype: "success" })
  })

  it("rejects a line without a type", () => {
    expect(() => decodeLine({ subtype: "init" })).toThrow()
  })
})
