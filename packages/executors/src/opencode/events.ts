import {
  addUsage,
  type Budget,
  type ExecutorEvent,
  ExecutorProtocolError,
  exceeds,
  SessionId,
  type Usage,
  usageToBudget,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"

// Base contract of every line: a JSON object with a string `type` and, on every event, the `sessionID`. The rest of the
// line passes through and is decoded only by the line types that use it.
export const OpencodeLine = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, sessionID: Schema.optionalKey(SessionId) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type OpencodeLine = typeof OpencodeLine.Type

const TextLine = Schema.Struct({ part: Schema.Struct({ text: Schema.String }) })

const ToolLine = Schema.Struct({
  part: Schema.Struct({
    tool: Schema.String,
    state: Schema.Struct({ status: Schema.String, input: Schema.optionalKey(Schema.Unknown) }),
  }),
})

const FinishLine = Schema.Struct({
  part: Schema.Struct({
    tokens: Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cache: Schema.optionalKey(
        Schema.Struct({ read: Schema.optionalKey(Schema.Number), write: Schema.optionalKey(Schema.Number) }),
      ),
    }),
    cost: Schema.optionalKey(Schema.Number),
  }),
})

// Observed on opencode 1.19.3: `error.name` plus `error.data.message`, not a `type`/`message` pair.
const ErrorLine = Schema.Struct({
  error: Schema.Struct({
    name: Schema.String,
    data: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
})

const BashInput = Schema.Struct({ command: Schema.String })
const FileInput = Schema.Struct({ filePath: Schema.String })
const decodeBashInput = Schema.decodeUnknownOption(BashInput)
const decodeFileInput = Schema.decodeUnknownOption(FileInput)

const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"])

const LINE_CLIP_CHARS = 300

export type OpencodeMapper = {
  // Maps one line to events. A line that does not fit its declared shape fails with ExecutorProtocolError.
  readonly push: (line: OpencodeLine) => Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError>
  // Process exited 0 without a terminal event: the last text is the result.
  readonly finish: () => ReadonlyArray<ExecutorEvent>
  readonly finished: () => boolean
}

const decodeAs = <A>(schema: Schema.Codec<A, unknown>, line: OpencodeLine) =>
  Schema.decodeUnknownEffect(schema)(line).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutorProtocolError({
          executor: "opencode",
          line: JSON.stringify(line).slice(0, LINE_CLIP_CHARS),
          cause,
        }),
    ),
  )

const toolStatus = (status: string): "started" | "completed" | "failed" => {
  if (status === "completed") return "completed"
  if (status === "error") return "failed"
  return "started"
}

// Per run: one mapper per execution. Once a terminal event (done|error) is emitted, nothing else is. Usage accumulates
// across steps; exceeding budget.tokens emits usage, then error{budget}.
export const makeOpencodeMapper = (budget: Budget): OpencodeMapper => {
  let finished = false
  let started = false
  let sessionId: SessionId | undefined
  let lastText = ""
  let total: Usage = ZERO_USAGE

  const terminate = (event: ExecutorEvent): ReadonlyArray<ExecutorEvent> => {
    finished = true
    return [event]
  }

  // The first line that carries a session id announces the run.
  const startEvents = (line: OpencodeLine): ReadonlyArray<ExecutorEvent> => {
    if (started || line.sessionID === undefined) return []
    started = true
    sessionId = line.sessionID
    return [{ kind: "started", sessionId: line.sessionID }]
  }

  const onTool = (line: OpencodeLine): Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError> =>
    decodeAs(ToolLine, line).pipe(
      Effect.map(({ part }): ReadonlyArray<ExecutorEvent> => {
        const status = toolStatus(part.state.status)
        const events: Array<ExecutorEvent> = [
          { kind: "tool_call", call: { tool: part.tool, input: part.state.input }, status },
        ]
        // Commands and file edits count only when the tool finished; a denied or failed call changed nothing.
        if (status !== "completed") return events
        if (part.tool === "bash") {
          const bash = decodeBashInput(part.state.input)
          if (Option.isSome(bash)) events.push({ kind: "command", cmd: bash.value.command })
        }
        if (FILE_EDIT_TOOLS.has(part.tool)) {
          const file = decodeFileInput(part.state.input)
          if (Option.isSome(file)) events.push({ kind: "file_edit", path: file.value.filePath })
        }
        return events
      }),
    )

  const onStepFinish = (
    line: OpencodeLine,
  ): Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError> =>
    decodeAs(FinishLine, line).pipe(
      Effect.map(({ part }): ReadonlyArray<ExecutorEvent> => {
        const usage: Usage = {
          tokensIn: part.tokens.input,
          tokensOut: part.tokens.output,
          cacheRead: part.tokens.cache?.read ?? 0,
          cacheWrite: part.tokens.cache?.write ?? 0,
          usd: part.cost ?? 0,
          seconds: 0,
        }
        total = addUsage(total, usage)
        const usageEvent: ExecutorEvent = { kind: "usage", usage }
        if (exceeds(usageToBudget(total), budget).exceeded) {
          return [
            usageEvent,
            ...terminate({
              kind: "error",
              code: "budget",
              message: `token budget of ${budget.tokens} exceeded`,
            }),
          ]
        }
        return [usageEvent]
      }),
    )

  const onError = (line: OpencodeLine): Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError> =>
    decodeAs(ErrorLine, line).pipe(
      Effect.map(({ error }) =>
        terminate({ kind: "error", code: "unknown", message: error.data?.message ?? error.name }),
      ),
    )

  const onLine = (line: OpencodeLine): Effect.Effect<ReadonlyArray<ExecutorEvent>, ExecutorProtocolError> => {
    switch (line.type) {
      case "text":
        return decodeAs(TextLine, line).pipe(
          Effect.map(({ part }): ReadonlyArray<ExecutorEvent> => {
            lastText = part.text
            return [{ kind: "text", text: part.text }]
          }),
        )
      case "reasoning":
        return decodeAs(TextLine, line).pipe(
          Effect.map(({ part }): ReadonlyArray<ExecutorEvent> => [{ kind: "thinking", text: part.text }]),
        )
      case "tool_use":
        return onTool(line)
      case "step_finish":
        return onStepFinish(line)
      case "error":
        return onError(line)
      // Other line types (step_start, ...) carry nothing the core keeps; they are skipped, not a failure.
      default:
        return Effect.succeed([])
    }
  }

  return {
    finished: () => finished,
    push: (line) => {
      if (finished) return Effect.succeed([])
      const head = startEvents(line)
      return onLine(line).pipe(Effect.map((events) => [...head, ...events]))
    },
    finish: () => {
      if (finished) return []
      return terminate({
        kind: "done",
        result: lastText,
        artifacts: [],
        ...(sessionId === undefined ? {} : { sessionId }),
      })
    },
  }
}
