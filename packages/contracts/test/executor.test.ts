import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ExecutorEvent, ExecutorTask, QuotaStatus, ToolCall } from "../src/executor.js"

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const STEP = "step_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
const ISO = "2026-10-19T12:00:00.000Z"
const USAGE = { tokensIn: 1200, tokensOut: 300, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 42 }
const CALL = { tool: "shell", input: { cmd: "git status" } }

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, raw: unknown): unknown =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(raw))

// One valid sample per ExecutorEvent variant (10).
const EVENT_SAMPLES: ReadonlyArray<Record<string, unknown>> = [
  { kind: "started", sessionId: "sess-abc-123", model: "haiku" },
  { kind: "thinking", text: "checking the repo" },
  { kind: "text", text: "done with step one" },
  { kind: "file_edit", path: "src/a.ts", diff: "@@ -1 +1 @@" },
  { kind: "command", cmd: "pnpm test", exitCode: 0, output: "ok" },
  { kind: "tool_call", call: CALL, status: "completed" },
  { kind: "approval_needed", action: CALL, risk: "external" },
  { kind: "usage", usage: USAGE },
  {
    kind: "done",
    result: "all green",
    artifacts: [{ kind: "text", ref: "summary" }],
    sessionId: "sess-abc-123",
  },
  { kind: "error", code: "max_turns", message: "turn limit reached" },
]

const TASK_SPEC = {
  taskId: TASK,
  stepId: STEP,
  botId: BOT,
  prompt: "refactor the parser",
  systemAppend: "be terse",
  tier: "heavy",
  allowedTools: ["Read", "Edit"],
  permissionMode: "edit",
  maxTurns: 20,
  budget: { tokens: 50000, seconds: 900, usd: 0.5 },
  resumeSessionId: "sess-abc-123",
}

describe("executor contracts", () => {
  it("ExecutorEvent has exactly 10 variants in the samples", () => {
    expect(EVENT_SAMPLES).toHaveLength(10)
    expect(new Set(EVENT_SAMPLES.map((e) => e.kind)).size).toBe(10)
  })

  for (const sample of EVENT_SAMPLES) {
    it(`round-trips the ${String(sample.kind)} variant`, () => {
      expect(roundTrip(ExecutorEvent, sample)).toEqual(sample)
    })
  }

  it("rejects an ExecutorEvent whose kind is outside the closed list", () => {
    expect(() => Schema.decodeUnknownSync(ExecutorEvent)({ kind: "nope", text: "x" })).toThrow()
  })

  it("rejects a tool_call status outside started, completed, failed", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExecutorEvent)({ kind: "tool_call", call: CALL, status: "pending" }),
    ).toThrow()
  })

  it("rejects an error code outside the closed list", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExecutorEvent)({ kind: "error", code: "timeout", message: "slow" }),
    ).toThrow()
  })

  it("rejects a usage event whose usage is missing a required field", () => {
    const { seconds: _seconds, ...partial } = USAGE
    expect(() => Schema.decodeUnknownSync(ExecutorEvent)({ kind: "usage", usage: partial })).toThrow()
  })

  it("ExecutorTask round-trips a fully specified task", () => {
    expect(roundTrip(ExecutorTask, TASK_SPEC)).toEqual(TASK_SPEC)
  })

  it("ExecutorTask round-trips without the optional fields", () => {
    const { stepId: _s, systemAppend: _a, resumeSessionId: _r, ...minimal } = TASK_SPEC
    expect(roundTrip(ExecutorTask, minimal)).toEqual(minimal)
  })

  it("ExecutorTask rejects a permissionMode outside the abstract modes", () => {
    expect(() => Schema.decodeUnknownSync(ExecutorTask)({ ...TASK_SPEC, permissionMode: "root" })).toThrow()
  })

  it("ExecutorTask rejects a non-integer maxTurns", () => {
    expect(() => Schema.decodeUnknownSync(ExecutorTask)({ ...TASK_SPEC, maxTurns: 2.5 })).toThrow()
  })

  it("ToolCall round-trips with and without resource", () => {
    expect(roundTrip(ToolCall, { tool: "Edit", input: { path: "a.ts" }, resource: "src/**" })).toEqual({
      tool: "Edit",
      input: { path: "a.ts" },
      resource: "src/**",
    })
    expect(roundTrip(ToolCall, CALL)).toEqual(CALL)
  })

  it("ToolCall rejects a missing tool name", () => {
    expect(() => Schema.decodeUnknownSync(ToolCall)({ input: {} })).toThrow()
  })

  const QUOTA = { executor: "claude-code", windowEndsAt: ISO, usedRatio: 0.42, available: true }

  it("QuotaStatus round-trips with windowEndsAt as an ISO string", () => {
    expect(roundTrip(QuotaStatus, QUOTA)).toEqual(QUOTA)
  })

  it("QuotaStatus round-trips without windowEndsAt", () => {
    const { windowEndsAt: _w, ...noWindow } = QUOTA
    expect(roundTrip(QuotaStatus, noWindow)).toEqual(noWindow)
  })

  it("QuotaStatus accepts the 0 and 1 bounds", () => {
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, usedRatio: 0 })).not.toThrow()
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, usedRatio: 1 })).not.toThrow()
  })

  it("QuotaStatus rejects a usedRatio above 1", () => {
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, usedRatio: 1.5 })).toThrow()
  })

  it("QuotaStatus rejects a usedRatio below 0", () => {
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, usedRatio: -0.1 })).toThrow()
  })

  it("QuotaStatus rejects a usedRatio that is NaN", () => {
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, usedRatio: Number.NaN })).toThrow()
  })

  it("QuotaStatus rejects an executor id with uppercase letters", () => {
    expect(() => Schema.decodeUnknownSync(QuotaStatus)({ ...QUOTA, executor: "Claude-Code" })).toThrow()
  })
})
