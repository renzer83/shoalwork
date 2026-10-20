import { isAbsolute } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { HttpError } from "../src/client.js"
import { memoryImport } from "../src/commands/memory-import.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const REPORT = {
  files: 1,
  chunks: 2,
  created: 2,
  superseded: 0,
  unchanged: 0,
  forgotten: 0,
  skipped: [{ path: "link.md", reason: "outside_root" }],
  rejected: ["leak.md"],
}
const BASE_FLAGS = { dir: "notes", scope: "bot:lead", kind: "semantic", source: "soul" }

// Replaces global fetch for one test; the mock is returned so the request can be inspected.
const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("memoryImport", () => {
  it.effect("posts the absolute directory and the scope, and answers the core report", () => {
    const mock = stubFetch(async () => new Response(JSON.stringify(REPORT), { status: 200 }))
    return Effect.gen(function* () {
      const report = yield* memoryImport(SETTINGS, BASE_FLAGS)
      expect(report).toEqual(REPORT)
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/memory/import")
      expect(init?.method).toBe("POST")
      expect(init?.headers).toMatchObject({ authorization: "Bearer dev-token" })
      const sent: unknown = JSON.parse(String(init?.body))
      expect(sent).toMatchObject({ scope: "bot:lead", kind: "semantic", source: "soul" })
      const dir = (sent as { readonly dir: string }).dir
      expect(isAbsolute(dir)).toBe(true)
      expect(dir.endsWith("/notes")).toBe(true)
    })
  })

  it.effect("fails with a usage error and sends nothing when a required flag is missing", () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }))
    return Effect.gen(function* () {
      const { source: _source, ...withoutSource } = BASE_FLAGS
      const failure = yield* memoryImport(SETTINGS, withoutSource).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("rejects a scope other than global or bot:<name> before any request", () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }))
    return Effect.gen(function* () {
      const failure = yield* memoryImport(SETTINGS, { ...BASE_FLAGS, scope: "pod:x" }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("rejects a kind other than semantic or procedural before any request", () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }))
    return Effect.gen(function* () {
      const failure = yield* memoryImport(SETTINGS, { ...BASE_FLAGS, kind: "working" }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("surfaces the HTTP status when the core refuses the import", () => {
    stubFetch(async () => new Response('{"error":"cannot read directory"}', { status: 400 }))
    return Effect.gen(function* () {
      const failure = yield* memoryImport(SETTINGS, BASE_FLAGS).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(HttpError)
      expect(failure).toMatchObject({ status: 400 })
    })
  })
})
