import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Budget, type ExecutorEvent, SessionId } from "@shoalwork/contracts"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  GeminiStreamLine,
  type MapperState,
  makeMapperState,
  toExecutorEvents,
} from "../../src/gemini/events.js"

// Fixtures under test/fixtures/gemini are synthetic: built from code-agent-clis.md §2 and the gemini-cli 0.59.0
// emitter. No logged-in Gemini CLI was available to record them.

const BIG: Budget = { tokens: 1_000_000, seconds: 600, usd: 10 }

const decode = (value: unknown): GeminiStreamLine => Schema.decodeUnknownSync(GeminiStreamLine)(value)

const fixtureLines = (name: string): ReadonlyArray<unknown> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/gemini/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line))

// Feeds lines in order and collects what the mapper emits, like the run stream does.
const feed = (
  values: ReadonlyArray<unknown>,
  budget: Budget = BIG,
): { readonly events: ReadonlyArray<ExecutorEvent>; readonly state: MapperState } => {
  const state = makeMapperState(budget)
  const events: Array<ExecutorEvent> = []
  for (const value of values) events.push(...toExecutorEvents(state, decode(value)))
  return { events, state }
}

const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

const at = "2026-10-21T10:00:00.000Z"
const assistant = (content: string, delta?: boolean) => ({
  type: "message",
  timestamp: at,
  role: "assistant",
  content,
  ...(delta === undefined ? {} : { delta }),
})
const resultOk = (input: number, output: number, cached: number) => ({
  type: "result",
  timestamp: at,
  status: "success",
  stats: { total_tokens: input + output, input_tokens: input, output_tokens: output, cached, input: 0 },
})

describe("gemini events schema", () => {
  it("decodes init into a SessionId and encodes it back unchanged", () => {
    const raw = {
      type: "init",
      timestamp: at,
      session_id: "6f1c2a4e-1111-4a2b-9c3d-000000000001",
      model: "gemini-pro-latest",
    }
    const decoded = decode(raw)
    expect(decoded).toMatchObject({
      type: "init",
      session_id: Schema.decodeUnknownSync(SessionId)("6f1c2a4e-1111-4a2b-9c3d-000000000001"),
    })
    expect(Schema.encodeSync(GeminiStreamLine)(decoded)).toEqual(raw)
  })

  it("rejects an unknown event type instead of dropping it", () => {
    expect(
      Option.isNone(Schema.decodeUnknownOption(GeminiStreamLine)({ type: "turn.started", timestamp: at })),
    ).toBe(true)
  })

  it("rejects a message whose role is not user or assistant, and an error without severity", () => {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(GeminiStreamLine)({
          type: "message",
          timestamp: at,
          role: "system",
          content: "x",
        }),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(GeminiStreamLine)({ type: "error", timestamp: at, message: "x" }),
      ),
    ).toBe(true)
  })
})

describe("gemini mapper", () => {
  it("maps init to started with the session id and model", () => {
    const { events } = feed([
      { type: "init", timestamp: at, session_id: "sess-1", model: "gemini-pro-latest" },
    ])
    expect(events).toEqual([
      {
        kind: "started",
        sessionId: Schema.decodeUnknownSync(SessionId)("sess-1"),
        model: "gemini-pro-latest",
      },
    ])
  })

  it("concatenates assistant deltas into one text event at the complete message", () => {
    const { events } = feed([
      assistant("Hel", true),
      assistant("lo ", true),
      assistant("world", true),
      assistant(""),
    ])
    expect(events).toEqual([{ kind: "text", text: "Hello world" }])
  })

  it("emits the complete assistant message once, without repeating its deltas", () => {
    const { events } = feed([assistant("Hi", true), assistant("Hi there")])
    expect(events).toEqual([{ kind: "text", text: "Hi there" }])
  })

  it("ignores user messages", () => {
    const { events } = feed([{ type: "message", timestamp: at, role: "user", content: "question" }])
    expect(events).toEqual([])
  })

  it("maps a shell tool_use to tool_call started and command, and a write tool to file_edit", () => {
    const { events } = feed([
      {
        type: "tool_use",
        timestamp: at,
        tool_name: "run_shell_command",
        tool_id: "t1",
        parameters: { command: "ls" },
      },
      {
        type: "tool_use",
        timestamp: at,
        tool_name: "write_file",
        tool_id: "t2",
        parameters: { file_path: "a.ts" },
      },
    ])
    expect(events).toEqual([
      {
        kind: "tool_call",
        call: { tool: "run_shell_command", input: { command: "ls" } },
        status: "started",
      },
      { kind: "command", cmd: "ls" },
      {
        kind: "tool_call",
        call: { tool: "write_file", input: { file_path: "a.ts" } },
        status: "started",
      },
      { kind: "file_edit", path: "a.ts" },
    ])
  })

  it("maps tool_result to tool_call completed or failed, and reads the exit code from the output", () => {
    const { events } = feed([
      {
        type: "tool_use",
        timestamp: at,
        tool_name: "run_shell_command",
        tool_id: "t1",
        parameters: { command: "pnpm test" },
      },
      {
        type: "tool_result",
        timestamp: at,
        tool_id: "t1",
        status: "success",
        output: "Exit Code: 0\n1 passed",
      },
      {
        type: "tool_use",
        timestamp: at,
        tool_name: "edit",
        tool_id: "t2",
        parameters: { file_path: "b.ts" },
      },
      {
        type: "tool_result",
        timestamp: at,
        tool_id: "t2",
        status: "error",
        error: { type: "X", message: "no match" },
      },
    ])
    // Order follows the stream: t1 started/command, t1 completed/exit code, t2 started/file_edit, t2 failed.
    expect(events.slice(2)).toEqual([
      {
        kind: "tool_call",
        call: { tool: "run_shell_command", input: { command: "pnpm test" } },
        status: "completed",
      },
      { kind: "command", cmd: "pnpm test", exitCode: 0 },
      {
        kind: "tool_call",
        call: { tool: "edit", input: { file_path: "b.ts" } },
        status: "started",
      },
      { kind: "file_edit", path: "b.ts" },
      {
        kind: "tool_call",
        call: { tool: "edit", input: { file_path: "b.ts" } },
        status: "failed",
      },
    ])
  })

  it("does not end the run on a warning, and ends it with error unknown on an error of severity error", () => {
    expect(
      feed([{ type: "error", timestamp: at, severity: "warning", message: "slow start" }]).events,
    ).toEqual([])
    expect(
      feed([{ type: "error", timestamp: at, severity: "error", message: "stream broke" }]).events,
    ).toEqual([{ kind: "error", code: "unknown", message: "stream broke" }])
  })

  it("emits usage then done with the last text and the session id on a successful result", () => {
    const { events } = feed([
      { type: "init", timestamp: at, session_id: "sess-9" },
      assistant("first"),
      assistant("final answer"),
      resultOk(1200, 5, 800),
    ])
    expect(events.slice(-2)).toEqual([
      {
        kind: "usage",
        usage: { tokensIn: 1200, tokensOut: 5, cacheRead: 800, cacheWrite: 0, usd: 0, seconds: 0 },
      },
      {
        kind: "done",
        result: "final answer",
        artifacts: [],
        sessionId: Schema.decodeUnknownSync(SessionId)("sess-9"),
      },
    ])
  })

  it("stops at the token budget: usage, then error budget, and ignores later lines", () => {
    const { events, state } = feed([resultOk(60, 50, 0), assistant("late")], {
      tokens: 100,
      seconds: 600,
      usd: 10,
    })
    expect(kinds(events)).toEqual(["usage", "error"])
    expect(events[1]).toEqual({ kind: "error", code: "budget", message: "token budget of 100 exceeded" })
    expect(state.finished).toBe(true)
    expect(toExecutorEvents(state, decode(assistant("again")))).toEqual([])
  })

  it("keeps a failed result as a pending failure without ending the run, for the exit code to decide", () => {
    const { events, state } = feed([
      {
        type: "result",
        timestamp: at,
        status: "error",
        error: { type: "FatalError", message: "Maximum session turns exceeded" },
      },
    ])
    expect(events).toEqual([])
    expect(state.finished).toBe(false)
    expect(state.failure).toBe("Maximum session turns exceeded")
  })
})

describe("gemini stream fixtures", () => {
  it("success fixture maps to started, text, usage and done", () => {
    const { events } = feed(fixtureLines("success.ndjson"))
    expect(kinds(events)).toEqual(["started", "text", "usage", "done"])
    expect(events.at(-1)).toMatchObject({ kind: "done", result: "pong", artifacts: [] })
  })

  it("with-tools fixture yields at least one command and one file_edit", () => {
    const { events } = feed(fixtureLines("with-tools.ndjson"))
    expect(events.some((event) => event.kind === "command")).toBe(true)
    expect(events.some((event) => event.kind === "file_edit")).toBe(true)
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      result: "Fixed the operator in src/sum.ts; the test passes.",
    })
  })

  it("error fixture yields no terminal event on its own, only a pending failure", () => {
    const { events, state } = feed(fixtureLines("error.ndjson"))
    expect(events.some((event) => event.kind === "done" || event.kind === "error")).toBe(false)
    expect(state.failure).toBe("Maximum session turns exceeded")
  })
})
