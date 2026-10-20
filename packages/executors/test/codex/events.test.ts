import { type Budget, type ExecutorEvent, SessionId } from "@shoalwork/contracts"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CodexEvent, makeCodexMapper } from "../../src/codex/events.js"

const BIG: Budget = { tokens: 1_000_000, seconds: 600, usd: 10 }

const decode = (value: unknown): CodexEvent => Schema.decodeUnknownSync(CodexEvent)(value)

const item = (value: Record<string, unknown>) => ({ type: "item.completed", item: value })

// Feeds events in order and collects everything the mapper emits, like the run stream does.
const feed = (budget: Budget, values: ReadonlyArray<unknown>): ReadonlyArray<ExecutorEvent> => {
  const mapper = makeCodexMapper(budget)
  const out: Array<ExecutorEvent> = []
  for (const value of values) out.push(...mapper.push(decode(value)))
  return out
}

const usageTurn = {
  type: "turn.completed",
  usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 },
}

describe("codex events schema", () => {
  it("decodes thread.started into a SessionId and encodes it back unchanged", () => {
    const raw = { type: "thread.started", thread_id: "thread-1" }
    const decoded = decode(raw)
    expect(decoded).toEqual({
      type: "thread.started",
      thread_id: Schema.decodeUnknownSync(SessionId)("thread-1"),
    })
    expect(Schema.encodeSync(CodexEvent)(decoded)).toEqual(raw)
  })

  it("rejects an unknown top-level event type instead of dropping it", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(CodexEvent)({ type: "turn.rewound" }))).toBe(true)
  })

  it("rejects thread.started without thread_id", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(CodexEvent)({ type: "thread.started" }))).toBe(true)
  })
})

describe("codex mapper", () => {
  it("maps reasoning to thinking and agent_message to text", () => {
    const events = feed(BIG, [
      item({ id: "i0", type: "reasoning", text: "checking the test" }),
      item({ id: "i1", type: "agent_message", text: "fixed" }),
    ])
    expect(events).toEqual([
      { kind: "thinking", text: "checking the test" },
      { kind: "text", text: "fixed" },
    ])
  })

  it("maps a completed command_execution to command with exit code and output", () => {
    const events = feed(BIG, [
      item({
        id: "i0",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "1 passed\n",
        exit_code: 0,
        status: "completed",
      }),
    ])
    expect(events).toEqual([{ kind: "command", cmd: "npm test", exitCode: 0, output: "1 passed\n" }])
  })

  it("emits one file_edit per change of a completed file_change", () => {
    const events = feed(BIG, [
      item({
        id: "i0",
        type: "file_change",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
        status: "completed",
      }),
    ])
    expect(events).toEqual([
      { kind: "file_edit", path: "src/a.ts" },
      { kind: "file_edit", path: "src/b.ts" },
    ])
  })

  it("maps mcp_tool_call to tool_call, with failed status when the item failed", () => {
    const events = feed(BIG, [
      item({
        id: "i0",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 7 },
        status: "failed",
      }),
    ])
    expect(events).toEqual([
      {
        kind: "tool_call",
        call: { tool: "get_issue", input: { number: 7 }, resource: "github" },
        status: "failed",
      },
    ])
  })

  it("skips started and updated item events and item types it does not map", () => {
    const events = feed(BIG, [
      {
        type: "item.started",
        item: { id: "i0", type: "command_execution", command: "ls", status: "in_progress" },
      },
      { type: "item.updated", item: { id: "i1", type: "todo_list", items: [] } },
      item({ id: "i2", type: "error", message: "Model metadata not found" }),
      { type: "turn.started" },
    ])
    expect(events).toEqual([])
  })

  it("emits usage with cache fields and then done with the last agent message and session id", () => {
    const events = feed(BIG, [
      { type: "thread.started", thread_id: "thread-9" },
      item({ id: "i0", type: "agent_message", text: "first" }),
      item({ id: "i1", type: "agent_message", text: "final answer" }),
      usageTurn,
    ])
    expect(events.slice(-2)).toEqual([
      {
        kind: "usage",
        usage: { tokensIn: 100, tokensOut: 20, cacheRead: 40, cacheWrite: 0, usd: 0, seconds: 0 },
      },
      {
        kind: "done",
        result: "final answer",
        artifacts: [],
        sessionId: Schema.decodeUnknownSync(SessionId)("thread-9"),
      },
    ])
  })

  it("stops at the token budget: usage, then error budget, and ignores later events", () => {
    const mapper = makeCodexMapper({ tokens: 100, seconds: 600, usd: 10 })
    const first = mapper.push(decode(usageTurn))
    expect(first.map((event) => event.kind)).toEqual(["usage", "error"])
    expect(first[1]).toEqual({ kind: "error", code: "budget", message: "token budget of 100 exceeded" })
    expect(mapper.finished()).toBe(true)
    expect(mapper.push(decode({ type: "turn.started" }))).toEqual([])
    expect(mapper.push(decode(usageTurn))).toEqual([])
  })

  it("ends the run with error unknown on turn.failed and on a top-level error", () => {
    expect(feed(BIG, [{ type: "turn.failed", error: { message: "boom" } }])).toEqual([
      { kind: "error", code: "unknown", message: "boom" },
    ])
    expect(feed(BIG, [{ type: "error", message: "stream closed" }])).toEqual([
      { kind: "error", code: "unknown", message: "stream closed" },
    ])
  })
})
