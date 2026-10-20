import {
  type ExecutorErrorCode,
  type ExecutorEvent,
  ExecutorProtocolError,
  SessionId,
  type ToolCall,
  type Usage,
} from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"

// Base contract of every line: a JSON object with a string `type`. Other fields pass through untouched and are
// decoded only by the line types that use them, so an odd field on a type the mapper ignores is never an error.
export const ClaudeStreamLine = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
export type ClaudeStreamLine = typeof ClaudeStreamLine.Type

const CliUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
})

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  tool_use_id: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
})
type ContentBlock = typeof ContentBlock.Type

// Per-type field sets. A field that does not fit its declared shape is a protocol error on that line type.
const InitFields = Schema.Struct({
  session_id: Schema.optionalKey(SessionId),
  model: Schema.optionalKey(Schema.String),
})
const MessageFields = Schema.Struct({
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(ContentBlock)]) }),
})
const ResultFields = Schema.Struct({
  subtype: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(SessionId),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  duration_ms: Schema.optionalKey(Schema.Number),
  total_cost_usd: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(CliUsage),
})

const BashInput = Schema.Struct({ command: Schema.String })
const FileInput = Schema.Struct({ file_path: Schema.String })
const decodeBashInput = Schema.decodeUnknownOption(BashInput)
const decodeFileInput = Schema.decodeUnknownOption(FileInput)

const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"])

// Per run: tool_result carries only tool_use_id, so the mapper remembers each tool_use; the init session id is kept
// as a fallback for result lines that omit session_id.
export type MapperState = {
  readonly executor: string
  readonly toolUses: Map<string, { readonly tool: string; readonly input: unknown }>
  sessionId?: SessionId
}

export const makeMapperState = (executor: string): MapperState => ({ executor, toolUses: new Map() })

const LINE_CLIP_CHARS = 300

const decodeLine = <A>(schema: Schema.Codec<A, unknown>, line: ClaudeStreamLine, state: MapperState) =>
  Schema.decodeUnknownEffect(schema)(line).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutorProtocolError({
          executor: state.executor,
          line: JSON.stringify(line).slice(0, LINE_CLIP_CHARS),
          cause,
        }),
    ),
  )

const initEvents = (line: ClaudeStreamLine, state: MapperState) =>
  decodeLine(InitFields, line, state).pipe(
    Effect.map((init): ReadonlyArray<ExecutorEvent> => {
      if (init.session_id !== undefined) state.sessionId = init.session_id
      return [
        {
          kind: "started",
          ...(init.session_id !== undefined ? { sessionId: init.session_id } : {}),
          ...(init.model !== undefined ? { model: init.model } : {}),
        },
      ]
    }),
  )

const toolUseEvents = (block: ContentBlock, state: MapperState): ReadonlyArray<ExecutorEvent> => {
  const tool = block.name ?? "unknown"
  const input = block.input
  if (block.id !== undefined) state.toolUses.set(block.id, { tool, input })
  const events: Array<ExecutorEvent> = [{ kind: "tool_call", call: { tool, input }, status: "started" }]
  if (tool === "Bash") {
    const bash = decodeBashInput(input)
    if (Option.isSome(bash)) events.push({ kind: "command", cmd: bash.value.command })
  }
  if (FILE_EDIT_TOOLS.has(tool)) {
    const file = decodeFileInput(input)
    if (Option.isSome(file)) events.push({ kind: "file_edit", path: file.value.file_path })
  }
  return events
}

const assistantBlockEvents = (
  blocks: ReadonlyArray<ContentBlock>,
  state: MapperState,
): ReadonlyArray<ExecutorEvent> =>
  blocks.flatMap((block): ReadonlyArray<ExecutorEvent> => {
    if (block.type === "text") return block.text !== undefined ? [{ kind: "text", text: block.text }] : []
    if (block.type === "tool_use") return toolUseEvents(block, state)
    return []
  })

const userBlockEvents = (
  blocks: ReadonlyArray<ContentBlock>,
  state: MapperState,
): ReadonlyArray<ExecutorEvent> =>
  blocks.flatMap((block): ReadonlyArray<ExecutorEvent> => {
    if (block.type !== "tool_result") return []
    const use = block.tool_use_id !== undefined ? state.toolUses.get(block.tool_use_id) : undefined
    const call: ToolCall = { tool: use?.tool ?? "unknown", input: use?.input }
    return [{ kind: "tool_call", call, status: block.is_error === true ? "failed" : "completed" }]
  })

// Both message kinds share the same content shape; `mapBlocks` decides what each block means.
const messageEvents = (
  line: ClaudeStreamLine,
  state: MapperState,
  mapBlocks: (blocks: ReadonlyArray<ContentBlock>, state: MapperState) => ReadonlyArray<ExecutorEvent>,
) =>
  decodeLine(MessageFields, line, state).pipe(
    Effect.map(({ message }) =>
      typeof message.content === "string" ? [] : mapBlocks(message.content, state),
    ),
  )

const usageOf = (fields: typeof ResultFields.Type): Usage => ({
  tokensIn: fields.usage?.input_tokens ?? 0,
  tokensOut: fields.usage?.output_tokens ?? 0,
  cacheRead: fields.usage?.cache_read_input_tokens ?? 0,
  cacheWrite: fields.usage?.cache_creation_input_tokens ?? 0,
  usd: fields.total_cost_usd ?? 0,
  seconds: Math.round((fields.duration_ms ?? 0) / 1000),
})

const errorCodeOf = (subtype: string | undefined): ExecutorErrorCode => {
  switch (subtype) {
    case "error_max_turns":
      return "max_turns"
    case "error_max_budget_usd":
      return "budget"
    default:
      return "unknown"
  }
}

const errorMessageOf = (fields: typeof ResultFields.Type): string =>
  [fields.errors?.join("; "), fields.result, fields.subtype].find(
    (text) => text !== undefined && text !== "",
  ) ?? "unknown"

// `result` is always the last line: usage first, then the terminal event.
const resultEvents = (line: ClaudeStreamLine, state: MapperState) =>
  decodeLine(ResultFields, line, state).pipe(
    Effect.map((fields): ReadonlyArray<ExecutorEvent> => {
      const usage: ExecutorEvent = { kind: "usage", usage: usageOf(fields) }
      if (fields.subtype === "success" && fields.is_error !== true) {
        const sessionId = fields.session_id ?? state.sessionId
        const done: ExecutorEvent = {
          kind: "done",
          result: fields.result ?? "",
          artifacts: [],
          ...(sessionId !== undefined ? { sessionId } : {}),
        }
        return [usage, done]
      }
      return [usage, { kind: "error", code: errorCodeOf(fields.subtype), message: errorMessageOf(fields) }]
    }),
  )

// Lines whose type has no mapping return [] (the caller logs the type). A malformed line of a mapped type fails with
// ExecutorProtocolError.
export const toExecutorEvents = (
  line: ClaudeStreamLine,
  state: MapperState,
): Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError> => {
  switch (line.type) {
    case "system":
      return line.subtype === "init" ? initEvents(line, state) : Effect.succeed([])
    case "assistant":
      return messageEvents(line, state, assistantBlockEvents)
    case "user":
      return messageEvents(line, state, userBlockEvents)
    case "result":
      return resultEvents(line, state)
    default:
      return Effect.succeed([])
  }
}
