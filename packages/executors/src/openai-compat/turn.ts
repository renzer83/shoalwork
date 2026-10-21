import type { Chunk } from "./sse.js"

// What one streamed assistant message adds up to, with ceilings so an endpoint cannot make a run grow without bound.
export const MAX_CALLS_PER_TURN = 32
// Arguments of one tool call: the biggest legitimate one is a write_file of FILE_MAX_BYTES (2 MB) plus JSON escapes.
export const MAX_ARGUMENT_CHARS = 2 * 1024 * 1024 + 64 * 1024
const ERROR_CHARS = 300

export type TurnToolCall = { index: number; id: string; name: string; arguments: string }

export type TurnAcc = {
  text: string
  finish: string | undefined
  sawDone: boolean
  usage: { tokensIn: number; tokensOut: number } | undefined
  failure: string | undefined
  readonly calls: Array<TurnToolCall>
}

export const newTurn = (): TurnAcc => ({
  text: "",
  finish: undefined,
  sawDone: false,
  usage: undefined,
  failure: undefined,
  calls: [],
})

const count = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.trunc(n))

const errorText = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message.slice(0, ERROR_CHARS)
  }
  return "the endpoint reported an error in the stream"
}

// A fragment with the index of the last call but a different id starts a new call (servers that reuse index 0).
const entryFor = (acc: TurnAcc, index: number, id: string | null | undefined): TurnToolCall | undefined => {
  let last: TurnToolCall | undefined
  for (const call of acc.calls) if (call.index === index) last = call
  if (last !== undefined && !(id && last.id !== "" && last.id !== id)) return last
  if (acc.calls.length >= MAX_CALLS_PER_TURN) {
    acc.failure = `the endpoint sent more than ${MAX_CALLS_PER_TURN} tool calls in one message`
    return undefined
  }
  const created: TurnToolCall = { index, id: "", name: "", arguments: "" }
  acc.calls.push(created)
  return created
}

// Folds a chunk into the turn and returns the text it carried (a text delta, or "").
export const foldChunk = (acc: TurnAcc, chunk: Chunk): string => {
  if (chunk.error !== undefined && chunk.error !== null) acc.failure = errorText(chunk.error)
  if (chunk.usage !== undefined && chunk.usage !== null) {
    acc.usage = {
      tokensIn: count(chunk.usage.prompt_tokens),
      tokensOut: count(chunk.usage.completion_tokens),
    }
  }
  let text = ""
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta
    if (delta?.content) {
      text += delta.content
      acc.text += delta.content
    }
    for (const fragment of delta?.tool_calls ?? []) {
      const entry = entryFor(acc, fragment.index ?? 0, fragment.id)
      if (entry === undefined) break
      if (fragment.id) entry.id = fragment.id
      if (fragment.function?.name) entry.name += fragment.function.name
      if (fragment.function?.arguments) entry.arguments += fragment.function.arguments
      if (entry.arguments.length > MAX_ARGUMENT_CHARS) {
        acc.failure = "the endpoint sent tool call arguments over the size limit"
        break
      }
    }
    if (choice.finish_reason) acc.finish = choice.finish_reason
  }
  return text
}
