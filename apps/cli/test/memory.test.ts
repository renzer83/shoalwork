import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { HttpError } from "../src/client.js"
import { memoryAdd, memoryEdit, memoryForget, memoryHistory, memorySearch } from "../src/commands/memory.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const BOT_ID = "bot_00000000-0000-4000-8000-000000000001"
const MEMORY_ID = "mem_00000000-0000-4000-8000-000000000002"
const VIEW = {
  id: MEMORY_ID,
  scope: "bot",
  ownerId: BOT_ID,
  kind: "semantic",
  content: "Deploy usa Fly.io",
  source: "user:cli",
  confidence: 1,
  createdAt: "2026-10-20T10:00:00.000Z",
  supersededBy: null,
  forgotten: false,
}

// Answers the requests in order; each entry is the body and status of one response.
const stubFetchSequence = (responses: ReadonlyArray<{ readonly status: number; readonly body: unknown }>) => {
  const queue = [...responses]
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift()
    if (next === undefined) {
      throw new Error("unexpected request")
    }
    return new Response(JSON.stringify(next.body), { status: next.status })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

const sentBody = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("memorySearch", () => {
  it.effect("resolves the bot, then searches its scope and answers the hits", () => {
    const mock = stubFetchSequence([
      { status: 200, body: { bot: { id: BOT_ID } } },
      { status: 200, body: [{ ...VIEW, score: 0.5 }] },
    ])
    return Effect.gen(function* () {
      const hits = yield* memorySearch(SETTINGS, { bot: "lead", k: "5" }, ["deploy", "fly"])
      expect(hits).toEqual([{ ...VIEW, score: 0.5 }])
      const [botUrl] = mock.mock.calls[0] ?? []
      expect(String(botUrl)).toBe("http://localhost:28900/bots/lead")
      const [memoryUrl, init] = mock.mock.calls[1] ?? []
      const url = new URL(String(memoryUrl))
      expect(url.pathname).toBe("/memory")
      expect(url.searchParams.get("bot")).toBe(BOT_ID)
      expect(url.searchParams.get("q")).toBe("deploy fly")
      expect(url.searchParams.get("k")).toBe("5")
      expect(init?.method).toBe("GET")
      expect(init?.headers).toMatchObject({ authorization: "Bearer dev-token" })
    })
  })

  it.effect("fails with a usage error and sends nothing without --bot or without query text", () => {
    const mock = stubFetchSequence([])
    return Effect.gen(function* () {
      expect(yield* memorySearch(SETTINGS, {}, ["deploy"]).pipe(Effect.flip)).toBeInstanceOf(UsageError)
      expect(yield* memorySearch(SETTINGS, { bot: "lead" }, ["  "]).pipe(Effect.flip)).toBeInstanceOf(
        UsageError,
      )
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("surfaces the HTTP status when the bot is unknown", () => {
    stubFetchSequence([{ status: 404, body: { error: "not found" } }])
    return Effect.gen(function* () {
      const failure = yield* memorySearch(SETTINGS, { bot: "ghost" }, ["deploy"]).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(HttpError)
      expect(failure).toMatchObject({ status: 404 })
    })
  })
})

describe("memoryAdd", () => {
  it.effect("posts a global memory with the cli user as the author", () => {
    const mock = stubFetchSequence([{ status: 201, body: { item: VIEW } }])
    return Effect.gen(function* () {
      const body = yield* memoryAdd(SETTINGS, {
        scope: "global",
        kind: "semantic",
        content: "Deploy usa Fly.io",
      })
      expect(body).toEqual({ item: VIEW })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/memory")
      expect(init?.method).toBe("POST")
      expect(sentBody(init)).toEqual({
        scope: "global",
        ownerId: "global",
        kind: "semantic",
        content: "Deploy usa Fly.io",
        userId: "cli",
      })
    })
  })

  it.effect("resolves bot:<name> to the BotId and uses the --user flag as the author", () => {
    const mock = stubFetchSequence([
      { status: 200, body: { bot: { id: BOT_ID } } },
      { status: 201, body: { item: VIEW } },
    ])
    return Effect.gen(function* () {
      yield* memoryAdd(SETTINGS, {
        scope: "bot:lead",
        kind: "procedural",
        content: "Rodar pnpm test antes do PR",
        user: "renan",
      })
      const [, init] = mock.mock.calls[1] ?? []
      expect(sentBody(init)).toEqual({
        scope: "bot",
        ownerId: BOT_ID,
        kind: "procedural",
        content: "Rodar pnpm test antes do PR",
        userId: "renan",
      })
    })
  })

  it.effect("rejects a bad scope or kind before any request", () => {
    const mock = stubFetchSequence([])
    return Effect.gen(function* () {
      const scope = yield* memoryAdd(SETTINGS, { scope: "pod:x", kind: "semantic", content: "x" }).pipe(
        Effect.flip,
      )
      expect(scope).toBeInstanceOf(UsageError)
      const kind = yield* memoryAdd(SETTINGS, { scope: "global", kind: "working", content: "x" }).pipe(
        Effect.flip,
      )
      expect(kind).toBeInstanceOf(UsageError)
      const content = yield* memoryAdd(SETTINGS, { scope: "global", kind: "semantic" }).pipe(Effect.flip)
      expect(content).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })
})

describe("memoryEdit, memoryForget, memoryHistory", () => {
  it.effect("edit patches the item with the new content and the author", () => {
    const mock = stubFetchSequence([{ status: 200, body: { item: { ...VIEW, id: "mem_next" } } }])
    return Effect.gen(function* () {
      const body = yield* memoryEdit(SETTINGS, MEMORY_ID, { content: "Deploy usa Fly.io 2", user: "renan" })
      expect(body.item.id).toBe("mem_next")
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`http://localhost:28900/memory/${MEMORY_ID}`)
      expect(init?.method).toBe("PATCH")
      expect(sentBody(init)).toEqual({ content: "Deploy usa Fly.io 2", userId: "renan" })
    })
  })

  it.effect("edit without --content fails before any request", () => {
    const mock = stubFetchSequence([])
    return Effect.gen(function* () {
      expect(yield* memoryEdit(SETTINGS, MEMORY_ID, {}).pipe(Effect.flip)).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("forget sends DELETE and answers the forgotten id", () => {
    const mock = stubFetchSequence([{ status: 200, body: { forgotten: MEMORY_ID } }])
    return Effect.gen(function* () {
      expect(yield* memoryForget(SETTINGS, MEMORY_ID)).toEqual({ forgotten: MEMORY_ID })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`http://localhost:28900/memory/${MEMORY_ID}`)
      expect(init?.method).toBe("DELETE")
    })
  })

  it.effect("history reads the chain of versions", () => {
    const mock = stubFetchSequence([{ status: 200, body: { items: [VIEW] } }])
    return Effect.gen(function* () {
      expect(yield* memoryHistory(SETTINGS, MEMORY_ID)).toEqual({ items: [VIEW] })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`http://localhost:28900/memory/${MEMORY_ID}/history`)
      expect(init?.method).toBe("GET")
    })
  })

  it.effect("surfaces a 404 from the core for an unknown memory id", () => {
    stubFetchSequence([{ status: 404, body: { error: "not found" } }])
    return Effect.gen(function* () {
      const failure = yield* memoryForget(SETTINGS, MEMORY_ID).pipe(Effect.flip)
      expect(failure).toMatchObject({ status: 404 })
    })
  })
})
