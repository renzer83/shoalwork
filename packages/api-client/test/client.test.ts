import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { ApiClient, HttpError } from "../src/index.js"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const healthy = {
  ok: true,
  version: "0.1.0",
  db: "ok",
  dbPath: "shoalwork.db",
  journalMode: "wal",
  uptimeSeconds: 12,
}

interface Seen {
  url: string
  init: RequestInit | undefined
}

const clientWith = (answer: () => Response | Promise<Response>, token: string | null = "secret") => {
  const seen: Array<Seen> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init })
    return answer()
  }
  return { seen, client: new ApiClient("http://core.test/", async () => token, fetchImpl) }
}

describe("ApiClient", () => {
  it.effect("decodes /health and sends the bearer token", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() => json(healthy))
      const health = yield* client.health()
      expect(health.version).toBe("0.1.0")
      expect(health.db).toBe("ok")
      expect(seen[0]?.url).toBe("http://core.test/health")
      expect(seen[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" })
    }),
  )

  it.effect("sends no authorization header without a token", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() => json(healthy), null)
      yield* client.health()
      expect(seen[0]?.init?.headers).not.toHaveProperty("authorization")
    }),
  )

  it.effect("decodes the 503 body of /health when the database is down", () =>
    Effect.gen(function* () {
      const down = { ...healthy, ok: false, db: "error", dbPath: null, journalMode: null }
      const { client } = clientWith(() => json(down, 503))
      const health = yield* client.health()
      expect(health.ok).toBe(false)
      expect(health.db).toBe("error")
    }),
  )

  it.effect("maps a 401 to HttpError with the status and body", () =>
    Effect.gen(function* () {
      const { client } = clientWith(() => json({ error: "unauthorized" }, 401))
      const exit = yield* Effect.exit(client.bots.list())
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* client.bots.list().pipe(Effect.flip)
      expect(error).toBeInstanceOf(HttpError)
      expect(error).toMatchObject({ status: 401, body: { error: "unauthorized" } })
    }),
  )

  it.effect("maps an invalid body to SchemaViolation", () =>
    Effect.gen(function* () {
      const { client } = clientWith(() => json({ bots: [{ id: 1 }] }))
      const error = yield* client.bots.list().pipe(Effect.flip)
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error).toMatchObject({ where: "GET /bots" })
    }),
  )

  it.effect("turns a network failure into HttpError status 0", () =>
    Effect.gen(function* () {
      const failing: typeof fetch = async () => {
        throw new TypeError("fetch failed")
      }
      const client = new ApiClient("http://core.test", async () => null, failing)
      const error = yield* client.bots.list().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "HttpError", status: 0, body: "fetch failed" })
    }),
  )

  it.effect("builds the query string of events and costs", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() => json({ events: [] }))
      yield* client.events.list({ stream: "task:t1", after: 4, types: ["budget.exceeded", "error.raised"] })
      expect(seen[0]?.url).toBe(
        "http://core.test/events?stream=task%3At1&after=4&types=budget.exceeded%2Cerror.raised",
      )
    }),
  )

  it.effect("posts the decision of an approval as JSON", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() => json({ result: "nope" }))
      const error = yield* client.approvals.resolve("appr_1", "approved").pipe(Effect.flip)
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(seen[0]?.init?.method).toBe("POST")
      expect(seen[0]?.init?.body).toBe(JSON.stringify({ decision: "approved", via: "web" }))
    }),
  )
})
