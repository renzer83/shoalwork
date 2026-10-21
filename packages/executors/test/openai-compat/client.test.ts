import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import { type ChatRequest, ChatRequestError, openChat } from "../../src/openai-compat/client.js"
import { fixture, scriptedFetch, sse } from "./harness.js"

const REQUEST: ChatRequest = {
  baseUrl: "http://localhost:11434/v1/",
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 4096,
  includeUsage: true,
}

const open = (responses: ReadonlyArray<() => Response>, request = REQUEST, onRefused = () => undefined) => {
  const script = scriptedFetch(responses)
  const response = openChat(script.fetcher, request, "1 millis", onRefused).pipe(Effect.scoped, Effect.result)
  return { script, response }
}

describe("openai-compat client", () => {
  it.effect("posts to <baseUrl>/chat/completions with the placeholder key when none is given", () =>
    Effect.gen(function* () {
      const { script, response } = open([() => sse(fixture("stream-text.sse"))])
      expect((yield* response)._tag).toBe("Success")
      expect(script.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions")
      expect(script.requests[0]?.headers.authorization).toBe("Bearer ollama")
      expect(script.requests[0]?.body).toMatchObject({
        model: "m",
        stream: true,
        max_tokens: 4096,
        stream_options: { include_usage: true },
      })
      expect(script.requests[0]?.body.tools).toBeUndefined()
    }),
  )

  it.effect("sends the apiKey as bearer and never puts it in an error message", () =>
    Effect.gen(function* () {
      const key = "k-secret-123"
      const { response } = open([() => sse(`bad key ${key}`, 401)], {
        ...REQUEST,
        apiKey: Redacted.make(key),
      })
      const result = yield* response
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ChatRequestError)
        expect(result.failure.code).toBe("auth")
        expect(result.failure.message).not.toContain(key)
      }
    }),
  )

  it.live("retries a 429 and then succeeds", () =>
    Effect.gen(function* () {
      const { script, response } = open([() => sse("slow down", 429), () => sse(fixture("stream-text.sse"))])
      expect((yield* response)._tag).toBe("Success")
      expect(script.requests).toHaveLength(2)
    }),
  )

  it.live("gives up after two retries on 5xx", () =>
    Effect.gen(function* () {
      const { script, response } = open([() => sse("down", 503)])
      const result = yield* response
      expect(script.requests).toHaveLength(3)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("unknown")
    }),
  )

  it.live("does not retry other 4xx", () =>
    Effect.gen(function* () {
      for (const status of [400, 401, 403, 404, 422]) {
        const { script, response } = open([() => sse("nope", status)])
        expect((yield* response)._tag).toBe("Failure")
        expect(script.requests).toHaveLength(1)
      }
    }),
  )

  it.effect("asks again without stream_options only when the error names it, and tells the caller", () =>
    Effect.gen(function* () {
      let refused = 0
      const { script, response } = open(
        [() => sse('{"error":"unknown field stream_options"}', 400), () => sse(fixture("stream-text.sse"))],
        REQUEST,
        () => {
          refused += 1
        },
      )
      expect((yield* response)._tag).toBe("Success")
      expect(script.requests[0]?.body.stream_options).toBeDefined()
      expect(script.requests[1]?.body.stream_options).toBeUndefined()
      expect(refused).toBe(1)
    }),
  )

  it.effect("a 400 that does not name stream_options is final", () =>
    Effect.gen(function* () {
      const { script, response } = open([() => sse("model not found", 400)])
      expect((yield* response)._tag).toBe("Failure")
      expect(script.requests).toHaveLength(1)
    }),
  )

  it.live("reads at most a few KB of an error body and cancels the rest", () =>
    Effect.gen(function* () {
      let pulled = 0
      let cancelled = false
      const endless = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 65_536
              controller.enqueue(new Uint8Array(65_536).fill(65))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 500 },
        )
      const { response } = open([endless, endless, endless])
      const result = yield* response.pipe(Effect.timeout("10 seconds"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message.length).toBeLessThan(400)
      expect(cancelled).toBe(true)
      // 3 attempts, each stopped after about one 64 KB chunk (plus the stream's own queue), never a whole body.
      expect(pulled).toBeLessThan(3 * 4 * 65_536)
    }),
  )
})
