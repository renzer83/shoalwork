import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import {
  DEFAULT_RETRY_AFTER_MS,
  MAX_RATE_RETRIES,
  makeNotion,
  NotionError,
  type NotionRequest,
  RATE_INTERVAL_MS,
} from "../../src/notion/client.js"
import { fail, fakeTransport, ok } from "./support.js"

const search: NotionRequest = {
  op: "notion.search",
  method: "post",
  path: "search",
  body: { query: "pautas" },
}

describe("notion client: rate limit and 429 policy", () => {
  it.effect("spaces requests at least RATE_INTERVAL_MS apart (2 rps), in order", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport(ok({ ok: true }))
      const notion = makeNotion(transport)
      const fiber = yield* Effect.forkChild(
        Effect.forEach([search, search, search], (request) => notion.request(request)),
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(fiber)
      expect(RATE_INTERVAL_MS).toBe(500)
      expect(sent.map((s) => s.at)).toEqual([0, 500, 1000])
    }),
  )

  it.effect("waits the Retry-After of a 429 and then retries the same request", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport((_request, index) =>
        index === 0 ? fail(429, 3000)(search, 0) : Effect.succeed({ results: [] }),
      )
      const notion = makeNotion(transport)
      const fiber = yield* Effect.forkChild(notion.request(search))
      yield* TestClock.adjust("5 seconds")
      const answer = yield* Fiber.join(fiber)
      expect(answer).toEqual({ results: [] })
      expect(sent.map((s) => s.at)).toEqual([0, 3000])
      expect(sent[1]?.request).toEqual(search)
    }),
  )

  it.effect("uses the default wait when a 429 carries no Retry-After", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport((_request, index) =>
        index === 0 ? fail(429)(search, 0) : Effect.succeed({}),
      )
      const fiber = yield* Effect.forkChild(makeNotion(transport).request(search))
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(fiber)
      expect(sent.map((s) => s.at)).toEqual([0, DEFAULT_RETRY_AFTER_MS])
    }),
  )

  it.effect("gives up after MAX_RATE_RETRIES retries with a message that has no answer body", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport(fail(429, 100))
      const fiber = yield* Effect.forkChild(Effect.flip(makeNotion(transport).request(search)))
      yield* TestClock.adjust("30 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(NotionError)
      expect(error.message).toBe("notion.search rate limited")
      expect(sent).toHaveLength(MAX_RATE_RETRIES + 1)
    }),
  )

  it.effect("does not retry a failure that is not a 429", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport(fail(500))
      const error = yield* Effect.flip(makeNotion(transport).request(search))
      expect(error.message).toBe("notion.search failed with HTTP 500")
      expect(sent).toHaveLength(1)
    }),
  )

  it.effect("reports a request that got no answer as a failure with no status", () =>
    Effect.gen(function* () {
      const { transport, sent } = fakeTransport(fail(0))
      const error = yield* Effect.flip(makeNotion(transport).request(search))
      expect(error.message).toBe("notion.search failed")
      expect(sent).toHaveLength(1)
    }),
  )
})
