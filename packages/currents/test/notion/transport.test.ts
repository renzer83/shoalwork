import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import {
  type NotionFetch,
  NotionHttpError,
  notionTransport,
  retryAfterMsOf,
} from "../../src/notion/client.js"

const TOKEN = "secret_test_token_not_real"

// A fetch stand-in: records the call and answers with a JSON body and headers. No network.
const answering = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const calls: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
  const fetch: NotionFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const text = JSON.stringify(body)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => text,
      body: null,
    }
  }
  return { fetch, calls }
}

describe("notion SDK transport", () => {
  it.effect("sends the pinned Notion-Version and the token, and returns the parsed answer", () =>
    Effect.gen(function* () {
      const { fetch, calls } = answering(200, { object: "list", results: [] })
      const transport = notionTransport(Redacted.make(TOKEN), { fetch })
      const answer = yield* transport.send({
        op: "notion.search",
        method: "post",
        path: "search",
        body: { query: "x" },
      })
      expect(answer).toEqual({ object: "list", results: [] })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://api.notion.com/v1/search")
      expect(calls[0]?.headers["Notion-Version"]).toBe("2026-03-11")
      const authorization = Object.entries(calls[0]?.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "authorization",
      )?.[1]
      expect(authorization).toBe(`Bearer ${TOKEN}`)
    }),
  )

  it.effect("maps a 429 to a NotionHttpError with its Retry-After, and keeps the body out of the error", () =>
    Effect.gen(function* () {
      const { fetch } = answering(
        429,
        { object: "error", status: 429, code: "rate_limited", message: "slow down" },
        { "retry-after": "3" },
      )
      const transport = notionTransport(Redacted.make(TOKEN), { fetch })
      const error = yield* Effect.flip(transport.send({ op: "notion.poll", method: "get", path: "pages/x" }))
      expect(error).toBeInstanceOf(NotionHttpError)
      expect(error.status).toBe(429)
      expect(error.retryAfterMs).toBe(3000)
      expect(JSON.stringify(error)).not.toContain("slow down")
    }),
  )

  it("reads Retry-After as seconds and ignores values that are neither seconds nor a date", () => {
    expect(retryAfterMsOf(new Headers({ "retry-after": "2" }))).toBe(2000)
    expect(retryAfterMsOf(new Headers({ "retry-after": "soon" }))).toBeUndefined()
    expect(retryAfterMsOf(new Headers())).toBeUndefined()
    expect(retryAfterMsOf(undefined)).toBeUndefined()
  })
})
