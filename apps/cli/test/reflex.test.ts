import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { HttpError } from "../src/client.js"
import { reflexExport } from "../src/commands/reflex.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const NDJSON = `${JSON.stringify({ decisionId: "evt_1", outcome: "correct" })}\n${JSON.stringify({ decisionId: "evt_2", outcome: "unknown" })}\n`

// Replaces global fetch for one test; the mock is returned so the request can be inspected.
const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoalwork-reflex-"))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe("reflexExport", () => {
  it.effect("downloads the dataset and writes it to --out", () => {
    const mock = stubFetch(async () => new Response(NDJSON, { status: 200 }))
    const out = join(dir, "dataset.jsonl")
    return Effect.gen(function* () {
      const written = yield* reflexExport(SETTINGS, { out })
      expect(written).toEqual({ out, lines: 2 })
      expect(yield* Effect.promise(() => readFile(out, "utf8"))).toBe(NDJSON)
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/reflex/export")
      expect(init?.headers).toMatchObject({ authorization: "Bearer dev-token" })
    })
  })

  it.effect("fails with a usage error when --out is missing", () => {
    const mock = stubFetch(async () => new Response(NDJSON, { status: 200 }))
    return Effect.gen(function* () {
      const failure = yield* reflexExport(SETTINGS, {}).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    })
  })

  it.effect("surfaces the HTTP status when the core refuses the token", () => {
    stubFetch(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    return Effect.gen(function* () {
      const failure = yield* reflexExport(SETTINGS, { out: join(dir, "x.jsonl") }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(HttpError)
      expect(failure).toMatchObject({ status: 401 })
    })
  })
})
