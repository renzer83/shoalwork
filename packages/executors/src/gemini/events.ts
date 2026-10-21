import {
  addUsage,
  type Budget,
  type ExecutorEvent,
  exceeds,
  SessionId,
  type ToolCallStatus,
  type Usage,
  usageToBudget,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Schema } from "effect"

// gemini-cli 0.59.0 stream-json, one object per line; every event carries `type` and `timestamp` (snake_case).
// Strict on the six known types: an unknown type fails the run as ExecutorProtocolError, like codex.
const InitLine = Schema.Struct({
  type: Schema.Literal("init"),
  timestamp: Schema.String,
  session_id: SessionId,
  model: Schema.optionalKey(Schema.String),
})
const MessageLine = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
  delta: Schema.optionalKey(Schema.Boolean),
})
const ToolUseLine = Schema.Struct({
  type: Schema.Literal("tool_use"),
  timestamp: Schema.String,
  tool_name: Schema.String,
  tool_id: Schema.String,
  parameters: Schema.optionalKey(Schema.Unknown),
})
const ToolResultLine = Schema.Struct({
  type: Schema.Literal("tool_result"),
  timestamp: Schema.String,
  tool_id: Schema.String,
  status: Schema.Literals(["success", "error"]),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
})
const ErrorLine = Schema.Struct({
  type: Schema.Literal("error"),
  timestamp: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
})
const Stats = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  cached: Schema.Int,
  duration_ms: Schema.optionalKey(Schema.Number),
  tool_calls: Schema.optionalKey(Schema.Int),
})
const ResultLine = Schema.Struct({
  type: Schema.Literal("result"),
  timestamp: Schema.String,
  status: Schema.Literals(["success", "error"]),
  error: Schema.optionalKey(Schema.Unknown),
  stats: Schema.optionalKey(Stats),
})

export const GeminiStreamLine = Schema.Union([
  InitLine,
  MessageLine,
  ToolUseLine,
  ToolResultLine,
  ErrorLine,
  ResultLine,
])
export type GeminiStreamLine = typeof GeminiStreamLine.Type

const ShellParams = Schema.Struct({ command: Schema.String })
const FileParams = Schema.Struct({ file_path: Schema.String })
const ErrorDetail = Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) })

const SHELL_TOOLS: ReadonlySet<string> = new Set(["run_shell_command", "shell"])
const EDIT_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit", "replace"])
// Assumed output format of a shell tool result; not verified against a recorded run.
const EXIT_CODE_TEXT = /exit code[:\s]+(-?\d+)/i

type PendingCall = { readonly tool: string; readonly input: unknown; readonly cmd: string | undefined }

// Stateful per run: one state per execution. A terminal event (done|error) makes every later line a no-op.
export type MapperState = {
  readonly budget: Budget
  finished: boolean
  sessionId: SessionId | undefined
  // Assistant deltas not yet emitted; a complete assistant message or the result flushes them.
  pending: string
  lastText: string
  total: Usage
  calls: Map<string, PendingCall>
  // Message of a result with status error. The process exit code, read at EOF, decides the error code.
  failure: string | undefined
}

export const makeMapperState = (budget: Budget): MapperState => ({
  budget,
  finished: false,
  sessionId: undefined,
  pending: "",
  lastText: "",
  total: ZERO_USAGE,
  calls: new Map(),
  failure: undefined,
})

const terminate = (state: MapperState, event: ExecutorEvent): ReadonlyArray<ExecutorEvent> => {
  state.finished = true
  return [event]
}

const flushPending = (state: MapperState): ReadonlyArray<ExecutorEvent> => {
  if (state.pending === "") return []
  const text = state.pending
  state.pending = ""
  state.lastText = text
  const event: ExecutorEvent = { kind: "text", text }
  return [event]
}

const onMessage = (
  state: MapperState,
  line: Extract<GeminiStreamLine, { type: "message" }>,
): ReadonlyArray<ExecutorEvent> => {
  if (line.role !== "assistant") return []
  if (line.delta === true) {
    state.pending += line.content
    return []
  }
  // A complete assistant message is authoritative; deltas before it are not emitted a second time.
  const text = line.content === "" ? state.pending : line.content
  state.pending = ""
  if (text === "") return []
  state.lastText = text
  return [{ kind: "text", text }]
}

const onToolUse = (
  state: MapperState,
  line: Extract<GeminiStreamLine, { type: "tool_use" }>,
): ReadonlyArray<ExecutorEvent> => {
  const params = line.parameters
  const cmd = SHELL_TOOLS.has(line.tool_name) && Schema.is(ShellParams)(params) ? params.command : undefined
  state.calls.set(line.tool_id, { tool: line.tool_name, input: params, cmd })
  const events: Array<ExecutorEvent> = [
    { kind: "tool_call", call: { tool: line.tool_name, input: params }, status: "started" },
  ]
  if (cmd !== undefined) events.push({ kind: "command", cmd })
  if (EDIT_TOOLS.has(line.tool_name) && Schema.is(FileParams)(params)) {
    events.push({ kind: "file_edit", path: params.file_path })
  }
  return events
}

const onToolResult = (
  state: MapperState,
  line: Extract<GeminiStreamLine, { type: "tool_result" }>,
): ReadonlyArray<ExecutorEvent> => {
  const call = state.calls.get(line.tool_id)
  state.calls.delete(line.tool_id)
  const status: ToolCallStatus = line.status === "success" ? "completed" : "failed"
  const events: Array<ExecutorEvent> = [
    { kind: "tool_call", call: { tool: call?.tool ?? "unknown", input: call?.input }, status },
  ]
  const match = line.output === undefined ? null : EXIT_CODE_TEXT.exec(line.output)
  const exitCode = match?.[1]
  if (call?.cmd !== undefined && exitCode !== undefined) {
    events.push({ kind: "command", cmd: call.cmd, exitCode: Number(exitCode) })
  }
  return events
}

const usageEvents = (
  state: MapperState,
  stats: Extract<GeminiStreamLine, { type: "result" }>["stats"],
): ReadonlyArray<ExecutorEvent> => {
  if (stats === undefined) return []
  const usage: Usage = {
    tokensIn: stats.input_tokens,
    tokensOut: stats.output_tokens,
    cacheRead: stats.cached,
    cacheWrite: 0,
    usd: 0,
    seconds: 0,
  }
  state.total = addUsage(state.total, usage)
  const event: ExecutorEvent = { kind: "usage", usage }
  if (exceeds(usageToBudget(state.total), state.budget).exceeded) {
    return [
      event,
      ...terminate(state, {
        kind: "error",
        code: "budget",
        message: `token budget of ${state.budget.tokens} exceeded`,
      }),
    ]
  }
  return [event]
}

const onResult = (
  state: MapperState,
  line: Extract<GeminiStreamLine, { type: "result" }>,
): ReadonlyArray<ExecutorEvent> => {
  const flushed = flushPending(state)
  const usage = usageEvents(state, line.stats)
  if (state.finished) return [...flushed, ...usage]
  if (line.status === "error") {
    const detail = Schema.is(ErrorDetail)(line.error) ? line.error.message : "gemini ended with an error"
    state.failure = detail
    return [...flushed, ...usage]
  }
  const sessionId = state.sessionId
  return [
    ...flushed,
    ...usage,
    ...terminate(state, {
      kind: "done",
      result: state.lastText,
      artifacts: [],
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  ]
}

export const toExecutorEvents = (
  state: MapperState,
  line: GeminiStreamLine,
): ReadonlyArray<ExecutorEvent> => {
  if (state.finished) return []
  switch (line.type) {
    case "init": {
      state.sessionId = line.session_id
      return [
        {
          kind: "started",
          sessionId: line.session_id,
          ...(line.model === undefined ? {} : { model: line.model }),
        },
      ]
    }
    case "message":
      return onMessage(state, line)
    case "tool_use":
      return onToolUse(state, line)
    case "tool_result":
      return onToolResult(state, line)
    case "error":
      // Warnings do not end the run; only severity error does.
      return line.severity === "error"
        ? terminate(state, { kind: "error", code: "unknown", message: line.message })
        : []
    case "result":
      return onResult(state, line)
  }
}
