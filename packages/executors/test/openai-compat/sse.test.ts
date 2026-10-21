import { it } from "@effect/vitest"
import { ExecutorProtocolError } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { type Chunk, chunksOf, MAX_LINE_BYTES, MAX_RESPONSE_BYTES } from "../../src/openai-compat/sse.js"
import { foldChunk, MAX_ARGUMENT_CHARS, MAX_CALLS_PER_TURN, newTurn } from "../../src/openai-compat/turn.js"
import { fixture, sse } from "./harness.js"

const bytesOf = (parts: ReadonlyArray<string | Uint8Array>): Response => {
  const encoder = new TextEncoder()
  let next = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[next]
        next += 1
        if (part === undefined) controller.close()
        else controller.enqueue(typeof part === "string" ? encoder.encode(part) : part)
      },
    }),
    { status: 200 },
  )
}

const collectChunks = (response: Response, onDone?: () => void) =>
  Stream.runCollect(chunksOf(response, "t", onDone)).pipe(Effect.result)

const fold = (chunks: ReadonlyArray<Chunk>) => {
  const acc = newTurn()
  for (const chunk of chunks) foldChunk(acc, chunk)
  return acc
}

const toolFragment = (index: number, id: string | undefined, args: string): Chunk => ({
  choices: [
    {
      delta: {
        tool_calls: [
          { index, ...(id === undefined ? {} : { id }), function: { name: "run_command", arguments: args } },
        ],
      },
    },
  ],
})

describe("openai-compat sse", () => {
  it.effect("parses the text fixture into deltas, skips comments, stops at [DONE] and reports it", () =>
    Effect.gen(function* () {
      let done = false
      const result = yield* collectChunks(sse(fixture("stream-text.sse")), () => {
        done = true
      })
      expect(result._tag).toBe("Success")
      const acc = fold(result._tag === "Success" ? Array.from(result.success) : [])
      expect(acc.text).toBe("pong")
      expect(acc.finish).toBe("stop")
      expect(acc.usage).toEqual({ tokensIn: 12, tokensOut: 2 })
      expect(done).toBe(true)
    }),
  )

  it.effect("accumulates tool call fragments by index into one call", () =>
    Effect.gen(function* () {
      const result = yield* collectChunks(sse(fixture("stream-toolcall.sse")))
      const acc = fold(result._tag === "Success" ? Array.from(result.success) : [])
      expect(acc.finish).toBe("tool_calls")
      expect(acc.calls).toEqual([
        { index: 0, id: "call_abc", name: "run_command", arguments: '{"cmd":["echo","hi"]}' },
      ])
    }),
  )

  it.effect("reassembles a data line that arrives split across network chunks", () =>
    Effect.gen(function* () {
      const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] })}\n\n`
      const cut = Math.floor(line.length / 2)
      const response = bytesOf([line.slice(0, cut), line.slice(cut), "data: [DONE]\n\n"])
      const result = yield* collectChunks(response)
      expect(result._tag).toBe("Success")
      expect(fold(result._tag === "Success" ? Array.from(result.success) : []).text).toBe("hello")
    }),
  )

  it.effect("fails with a protocol error on a payload that is not JSON", () =>
    Effect.gen(function* () {
      const result = yield* collectChunks(sse("data: {not json\n\n"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ExecutorProtocolError)
    }),
  )

  it.effect("fails with a protocol error on a line over the limit, even without a newline", () =>
    Effect.gen(function* () {
      const piece = new Uint8Array(64 * 1024).fill(97)
      const pieces = Array.from({ length: MAX_LINE_BYTES / piece.length + 2 }, () => piece)
      const result = yield* collectChunks(bytesOf(["data: ", ...pieces]))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ExecutorProtocolError)
    }),
  )

  it.effect("fails with a protocol error on a single oversized line inside one network chunk", () =>
    Effect.gen(function* () {
      const result = yield* collectChunks(bytesOf([`data: ${"a".repeat(MAX_LINE_BYTES + 10)}\n`]))
      expect(result._tag).toBe("Failure")
    }),
  )

  it.effect("fails with a protocol error when the whole response goes over the limit", () =>
    Effect.gen(function* () {
      const line = `data: {"choices":[{"delta":{"content":"${"x".repeat(1000)}"}}]}\n\n`
      const lines = Array.from({ length: Math.ceil(MAX_RESPONSE_BYTES / line.length) + 5 }, () => line)
      const result = yield* collectChunks(bytesOf(lines))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ExecutorProtocolError)
    }),
  )

  it("an error of null is not an error, an error object is", () => {
    const quiet = fold([{ choices: [{ delta: { content: "ok" } }], error: null }])
    expect(quiet.failure).toBeUndefined()
    const broken = fold([{ error: { message: "upstream exploded" } }])
    expect(broken.failure).toBe("upstream exploded")
  })

  it("a new id on the same index opens a new call", () => {
    const acc = fold([
      toolFragment(0, "a", '{"cmd":["x"]}'),
      toolFragment(0, "b", '{"cmd":["y"]}'),
      toolFragment(0, undefined, ""),
    ])
    expect(acc.calls.map((call) => call.id)).toEqual(["a", "b"])
  })

  it("keeps appending to the call of the same index while the id is absent or equal", () => {
    const acc = fold([
      toolFragment(0, "a", '{"cmd":'),
      toolFragment(0, undefined, '["x"]}'),
      toolFragment(0, "a", ""),
    ])
    expect(acc.calls).toHaveLength(1)
    expect(acc.calls[0]?.arguments).toBe('{"cmd":["x"]}')
  })

  it("more than the allowed number of calls in one message is a failure, not a growing map", () => {
    const acc = fold(
      Array.from({ length: MAX_CALLS_PER_TURN + 5 }, (_, i) => toolFragment(i * 1000, undefined, "{}")),
    )
    expect(acc.calls).toHaveLength(MAX_CALLS_PER_TURN)
    expect(acc.failure).toContain("tool calls")
  })

  it("arguments over the limit are a failure", () => {
    const acc = fold([toolFragment(0, "a", "x".repeat(MAX_ARGUMENT_CHARS + 1))])
    expect(acc.failure).toContain("size limit")
  })
})
