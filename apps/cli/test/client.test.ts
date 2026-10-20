import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { ApiClient, Health, HttpError } from "../src/client.js"

const HEALTHY = {
  ok: true,
  version: "0.0.0",
  db: "ok",
  dbPath: "shoalwork.db",
  journalMode: "wal",
  uptimeSeconds: 12,
}

const client = new ApiClient("http://localhost:28900", "dev-token")

// Replaces global fetch for one test; the mock is returned so the request can be inspected.
const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ApiClient.get", () => {
  it.effect("decodes a valid response into the schema type", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json(HEALTHY))

      const body = yield* client.get("/health", Health)

      expect(body).toEqual(HEALTHY)
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/health")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dev-token")
    }),
  )

  it.effect("maps a 401 response to HttpError with its status", () =>
    Effect.gen(function* () {
      stubFetch(async () => json({ error: "unauthorized" }, 401))

      const error = yield* Effect.flip(client.get("/health", Health))

      expect(error).toBeInstanceOf(HttpError)
      expect(error).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' })
    }),
  )

  it.effect("rejects a body that does not match the schema with SchemaViolation", () =>
    Effect.gen(function* () {
      stubFetch(async () => json({ ...HEALTHY, uptimeSeconds: 1.5 }))

      const error = yield* Effect.flip(client.get("/health", Health))

      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error).toMatchObject({ where: "GET /health" })
    }),
  )

  it.effect("rejects a 200 body that is not JSON with SchemaViolation", () =>
    Effect.gen(function* () {
      stubFetch(async () => new Response("<html>", { status: 200 }))

      const error = yield* Effect.flip(client.get("/health", Health))

      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("reports a failed connection as HttpError with status 0", () =>
    Effect.gen(function* () {
      stubFetch(async () => {
        throw new TypeError("fetch failed")
      })

      const error = yield* Effect.flip(client.get("/health", Health))

      expect(error).toBeInstanceOf(HttpError)
      expect(error).toMatchObject({ status: 0, body: "request failed: fetch failed" })
    }),
  )
})

describe("ApiClient.post", () => {
  it.effect("sends the body as JSON with the bearer token and decodes the reply", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ ok: true }))

      const body = yield* client.post("/echo", { hello: "world" }, Schema.Struct({ ok: Schema.Boolean }))

      expect(body).toEqual({ ok: true })
      const [, init] = mock.mock.calls[0] ?? []
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe('{"hello":"world"}')
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dev-token")
    }),
  )
})
