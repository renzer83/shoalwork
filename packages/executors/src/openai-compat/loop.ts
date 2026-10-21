import {
  type ExecutorEvent,
  type ExecutorProtocolError,
  type ExecutorTask,
  exceeds,
  type Usage,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { type Duration, Effect, type Redacted, Stream } from "effect"
import {
  type ChatMessage,
  type ChatRequestError,
  type FetchLike,
  openChat,
  type ToolCallMsg,
} from "./client.js"
import { chunksOf } from "./sse.js"
import { runTool, type ToolDeps, type ToolOutcome, toolDefs } from "./tools.js"
import { foldChunk, newTurn, type TurnAcc } from "./turn.js"

export type LoopDeps = {
  readonly executor: string
  readonly fetcher: FetchLike
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model: string
  readonly supportsTools: boolean
  readonly maxTokens: number
  readonly retryBase: Duration.Input
  readonly tools: ToolDeps
}

type Events = Stream.Stream<ExecutorEvent, ExecutorProtocolError>

const many = (events: ReadonlyArray<ExecutorEvent>): Events => Stream.fromIterable(events)

// Tokens of text the endpoint did not count: about four characters each. Only used when no usage came back.
const estimate = (chars: number): number => Math.ceil(chars / 4)

const LENGTH_NOTE = "the answer was cut by the token limit (finish_reason length)"

const NO_USAGE_NOTE = "the endpoint reported no token usage; tokens are estimated from text length (chars/4)"

const requestFailure = (error: ChatRequestError): ExecutorEvent => ({
  kind: "error",
  code: error.code,
  message: error.message,
})

// assistant(tool_calls) → tool results → … until a message without tool calls, `maxTurns` model calls, or a pause for
// approval. The history lives only in this run: a later run (resume after approval) starts a new conversation.
export const runLoop = (deps: LoopDeps, task: ExecutorTask): Events => {
  const tools = deps.supportsTools ? toolDefs(deps.tools.mode) : []
  const messages: Array<ChatMessage> = [
    ...(task.systemAppend === undefined ? [] : [{ role: "system" as const, content: task.systemAppend }]),
    { role: "user", content: task.prompt },
  ]
  const maxTurns = Math.max(1, task.maxTurns)
  const spent = { tokens: 0 }
  const noted = { done: false }
  const usageMode = { enabled: true }

  const toolPhase = (acc: TurnAcc, n: number): Events => {
    const calls: ReadonlyArray<ToolCallMsg> = acc.calls
      .filter((call) => call.name !== "")
      .map((call, position) => ({
        id: call.id === "" ? `call_${n}_${position}` : call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      }))
    messages.push({ role: "assistant", content: acc.text === "" ? null : acc.text, tool_calls: calls })
    let asked = false
    const record = (call: ToolCallMsg, outcome: ToolOutcome): ToolOutcome => {
      if (outcome.kind === "ask") asked = true
      else messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content })
      return outcome
    }
    return Stream.fromIterable(calls).pipe(
      Stream.mapEffect((call) =>
        Effect.map(runTool(deps.tools, call.function.name, call.function.arguments), (o) => record(call, o)),
      ),
      Stream.takeUntil((outcome) => outcome.kind === "ask"),
      Stream.flatMap(
        (outcome): Events =>
          outcome.kind === "ask"
            ? Stream.make({ kind: "approval_needed", action: outcome.action, risk: outcome.risk })
            : many(outcome.events),
      ),
      Stream.concat(Stream.unwrap(Effect.sync((): Events => (asked ? Stream.empty : turn(n + 1))))),
    )
  }

  const usageOf = (acc: TurnAcc, inChars: number): Usage => {
    if (acc.usage !== undefined) return { ...ZERO_USAGE, ...acc.usage }
    const outChars =
      acc.text.length + acc.calls.reduce((sum, c) => sum + c.name.length + c.arguments.length, 0)
    return { ...ZERO_USAGE, tokensIn: estimate(inChars), tokensOut: estimate(outChars) }
  }

  const fail = (code: "unknown" | "protocol" | "budget" | "max_turns", message: string): ExecutorEvent => ({
    kind: "error",
    code,
    message,
  })

  // What follows the stream of one model call: usage, then done, an error, or the tools and the next call.
  const afterTurn = (acc: TurnAcc, n: number, inChars: number): Events => {
    const usage = usageOf(acc, inChars)
    spent.tokens += usage.tokensIn + usage.tokensOut
    const note: ReadonlyArray<ExecutorEvent> =
      acc.usage === undefined && !noted.done ? [{ kind: "thinking", text: NO_USAGE_NOTE }] : []
    if (acc.usage === undefined) noted.done = true
    const head: ReadonlyArray<ExecutorEvent> = [...note, { kind: "usage", usage }]
    const stop = (event: ExecutorEvent): Events => many([...head, event])
    if (acc.failure !== undefined) return stop(fail("unknown", acc.failure))
    // Nothing is executed from an answer that was cut or filtered: its tool calls may be incomplete.
    const hasCalls = acc.calls.some((call) => call.name !== "")
    if (acc.finish === "content_filter" || (acc.finish === "length" && hasCalls)) {
      return stop(fail("unknown", `the answer ended early (finish_reason ${acc.finish})`))
    }
    if (acc.finish === undefined && !acc.sawDone) {
      return stop(fail("protocol", "the stream ended without finish_reason or [DONE]"))
    }
    const over = exceeds({ tokens: spent.tokens, seconds: 0, usd: 0 }, task.budget)
    if (over.exceeded) return stop(fail("budget", `budget exceeded: ${over.by.join(", ")}`))
    const wantsTools = tools.length > 0 && hasCalls
    if (!wantsTools) {
      // A text answer cut by max_tokens is still the answer; the cut is noted.
      const cut: ReadonlyArray<ExecutorEvent> =
        acc.finish === "length" ? [{ kind: "thinking", text: LENGTH_NOTE }] : []
      return many([...head, ...cut, { kind: "done", result: acc.text, artifacts: [] }])
    }
    if (n >= maxTurns) return stop(fail("max_turns", `reached the limit of ${maxTurns} model calls`))
    return Stream.concat(many(head), toolPhase(acc, n))
  }

  const turn = (n: number): Events =>
    Stream.unwrap(
      Effect.gen(function* () {
        const acc = newTurn()
        const inChars = JSON.stringify(messages).length
        const response = yield* openChat(
          deps.fetcher,
          {
            baseUrl: deps.baseUrl,
            apiKey: deps.apiKey,
            model: deps.model,
            messages,
            tools,
            maxTokens: deps.maxTokens,
            includeUsage: usageMode.enabled,
          },
          deps.retryBase,
          () => {
            usageMode.enabled = false
          },
        )
        const live = chunksOf(response, deps.executor, () => {
          acc.sawDone = true
        }).pipe(
          Stream.map((chunk) => ({ text: foldChunk(acc, chunk), stop: acc.failure !== undefined })),
          // A chunk that broke a limit ends the read; afterTurn reports it.
          Stream.takeWhile((step) => !step.stop),
          Stream.flatMap(
            (step): Events =>
              step.text === "" ? Stream.empty : Stream.make({ kind: "text", text: step.text }),
          ),
        )
        return Stream.concat(live, Stream.unwrap(Effect.sync(() => afterTurn(acc, n, inChars))))
      }),
    ).pipe(Stream.catchTag("ChatRequestError", (error) => Stream.make(requestFailure(error))))

  return Stream.concat(Stream.make({ kind: "started", model: deps.model }), turn(1))
}
