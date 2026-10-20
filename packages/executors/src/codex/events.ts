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

const CodexUsage = Schema.Struct({
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  cached_input_tokens: Schema.optionalKey(Schema.Int),
  cache_write_input_tokens: Schema.optionalKey(Schema.Int),
})

const AgentMessageItem = Schema.Struct({ type: Schema.Literal("agent_message"), text: Schema.String })
const ReasoningItem = Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String })
const CommandItem = Schema.Struct({
  type: Schema.Literal("command_execution"),
  command: Schema.String,
  aggregated_output: Schema.optionalKey(Schema.String),
  exit_code: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  status: Schema.String,
})
const FileChangeItem = Schema.Struct({
  type: Schema.Literal("file_change"),
  changes: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.optionalKey(Schema.String) })),
  status: Schema.String,
})
const McpToolItem = Schema.Struct({
  type: Schema.Literal("mcp_tool_call"),
  server: Schema.String,
  tool: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  status: Schema.String,
})

// Items of other types (error, web_search, todo_list, ...) are not mapped. The top-level `item` stays
// unknown and is decoded with this union inside the mapper, so an unmapped item type is skipped, not a failure.
export const KnownItem = Schema.Union([
  AgentMessageItem,
  ReasoningItem,
  CommandItem,
  FileChangeItem,
  McpToolItem,
])
export type KnownItem = typeof KnownItem.Type

// Top-level types are strict: an unknown type fails the run as ExecutorProtocolError instead of being dropped.
export const CodexEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread.started"), thread_id: SessionId }),
  Schema.Struct({ type: Schema.Literal("turn.started") }),
  Schema.Struct({
    type: Schema.Literals(["item.started", "item.updated", "item.completed"]),
    item: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal("turn.completed"), usage: CodexUsage }),
  Schema.Struct({ type: Schema.Literal("turn.failed"), error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])
export type CodexEvent = typeof CodexEvent.Type

export type CodexMapper = {
  readonly push: (event: CodexEvent) => ReadonlyArray<ExecutorEvent>
  readonly finished: () => boolean
}

const toolStatus = (status: string): ToolCallStatus => {
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  return "started"
}

const mapItem = (item: KnownItem): ReadonlyArray<ExecutorEvent> => {
  switch (item.type) {
    case "reasoning":
      return [{ kind: "thinking", text: item.text }]
    case "agent_message":
      return [{ kind: "text", text: item.text }]
    case "command_execution":
      return [
        {
          kind: "command",
          cmd: item.command,
          ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
          ...(item.aggregated_output === undefined ? {} : { output: item.aggregated_output }),
        },
      ]
    case "file_change":
      return item.changes.map((change): ExecutorEvent => ({ kind: "file_edit", path: change.path }))
    case "mcp_tool_call":
      return [
        {
          kind: "tool_call",
          call: { tool: item.tool, input: item.arguments, resource: item.server },
          status: toolStatus(item.status),
        },
      ]
  }
}

// Pure, stateful per run: one mapper per execution. Once a terminal event (done|error) is emitted, nothing else is.
// Usage is accumulated across turns; exceeding budget.tokens emits usage, then error{budget}.
export const makeCodexMapper = (budget: Budget): CodexMapper => {
  let finished = false
  let sessionId: SessionId | undefined
  let lastMessage = ""
  let total: Usage = ZERO_USAGE

  const terminate = (event: ExecutorEvent): ReadonlyArray<ExecutorEvent> => {
    finished = true
    return [event]
  }

  const onTurnCompleted = (raw: typeof CodexUsage.Type): ReadonlyArray<ExecutorEvent> => {
    const usage: Usage = {
      tokensIn: raw.input_tokens,
      tokensOut: raw.output_tokens,
      cacheRead: raw.cached_input_tokens ?? 0,
      cacheWrite: raw.cache_write_input_tokens ?? 0,
      usd: 0,
      seconds: 0,
    }
    total = addUsage(total, usage)
    const usageEvent: ExecutorEvent = { kind: "usage", usage }
    if (exceeds(usageToBudget(total), budget).exceeded) {
      return [
        usageEvent,
        ...terminate({ kind: "error", code: "budget", message: `token budget of ${budget.tokens} exceeded` }),
      ]
    }
    return [
      usageEvent,
      ...terminate({
        kind: "done",
        result: lastMessage,
        artifacts: [],
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    ]
  }

  return {
    finished: () => finished,
    push: (event) => {
      if (finished) return []
      switch (event.type) {
        case "thread.started":
          sessionId = event.thread_id
          return [{ kind: "started", sessionId: event.thread_id }]
        case "item.completed": {
          const item: unknown = event.item
          if (!Schema.is(KnownItem)(item)) return []
          if (item.type === "agent_message") lastMessage = item.text
          return mapItem(item)
        }
        case "item.started":
        case "item.updated":
        case "turn.started":
          return []
        case "turn.completed":
          return onTurnCompleted(event.usage)
        case "turn.failed":
          return terminate({ kind: "error", code: "unknown", message: event.error.message })
        case "error":
          return terminate({ kind: "error", code: "unknown", message: event.message })
      }
    },
  }
}
