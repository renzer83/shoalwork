import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { it } from "@effect/vitest"
import { runMigrations } from "@shoalwork/db"
import { withRawTempDb, withTempDb } from "@shoalwork/db/testing"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  cosine,
  Embedder,
  EmbedderOllamaLive,
  EmbedderTest,
  EmbedError,
  normalize,
  testVector,
} from "../src/embedder.js"
import { decodeEmbedding, EMBED_DIMS, EmbeddingShapeError, encodeEmbedding, MemoryRow } from "../src/rows.js"

const CREATED_AT = "2026-10-20T00:00:00.000Z"

// Marker vector: different texts give different directions, so order mistakes are visible.
const markerVector = (text: string): Array<number> =>
  Array.from({ length: EMBED_DIMS }, (_, index) => (index < text.length ? text.charCodeAt(index) : 1))

describe("memory_items migration", () => {
  it.effect("applies 0006_memory.sql and a second run applies nothing", () =>
    Effect.gen(function* () {
      const first = yield* runMigrations
      expect(first).toContain("0006_memory.sql")
      const second = yield* runMigrations
      expect(second).toEqual([])
    }).pipe(Effect.provide(withRawTempDb())),
  )

  it.effect("keeps memory_fts in step with inserts, updates and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const match = (term: string) =>
        sql<{ readonly rowid: number }>`SELECT rowid FROM memory_fts WHERE memory_fts MATCH ${term}`
      yield* sql`INSERT INTO memory_items (id, scope, owner_id, kind, content, source, created_at)
        VALUES ('mem_1', 'bot', 'bot_1', 'semantic', 'gato preto', 'test', ${CREATED_AT})`
      expect(yield* match("gato")).toHaveLength(1)
      yield* sql`UPDATE memory_items SET content = 'cachorro marrom' WHERE id = 'mem_1'`
      expect(yield* match("gato")).toHaveLength(0)
      expect(yield* match("cachorro")).toHaveLength(1)
      yield* sql`DELETE FROM memory_items WHERE id = 'mem_1'`
      expect(yield* match("cachorro")).toHaveLength(0)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("stores the embedding BLOB and reads it back through MemoryRow", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const vector = testVector("memória de teste")
      const bytes = yield* encodeEmbedding(vector)
      yield* sql`INSERT INTO memory_items (id, scope, owner_id, kind, content, source, created_at, embedding)
        VALUES ('mem_2', 'pod', 'pod_1', 'episodic', 'resumo', 'task', ${CREATED_AT}, ${bytes})`
      const raw = yield* sql`SELECT * FROM memory_items WHERE id = 'mem_2'`
      const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(MemoryRow))(raw)
      expect(row).toMatchObject({
        id: "mem_2",
        scope: "pod",
        kind: "episodic",
        confidence: 1,
        superseded_by: null,
        tombstone: 0,
      })
      const stored = yield* decodeEmbedding(row?.embedding ?? new Uint8Array())
      expect(Array.from(stored)).toEqual(vector.map(Math.fround))
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("float32 BLOB codec", () => {
  it.effect("writes float32 little-endian", () =>
    Effect.gen(function* () {
      const vector = Array.from({ length: EMBED_DIMS }, (_, index) => (index === 0 ? 1 : 0))
      const bytes = yield* encodeEmbedding(vector)
      // 1.0 as float32 little-endian is 0x3F800000
      expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x00, 0x80, 0x3f])
      expect(bytes.byteLength).toBe(EMBED_DIMS * 4)
    }),
  )

  it.effect("round-trips a vector (float32 precision)", () =>
    Effect.gen(function* () {
      const vector = testVector("round trip")
      const decoded = yield* encodeEmbedding(vector).pipe(Effect.flatMap(decodeEmbedding))
      expect(Array.from(decoded)).toEqual(vector.map(Math.fround))
    }),
  )

  it.effect("rejects a vector with the wrong length", () =>
    Effect.gen(function* () {
      const error = yield* encodeEmbedding([1, 2, 3]).pipe(Effect.flip)
      expect(error).toBeInstanceOf(EmbeddingShapeError)
    }),
  )

  it.effect("rejects a BLOB with the wrong byte length", () =>
    Effect.gen(function* () {
      const error = yield* decodeEmbedding(new Uint8Array(12)).pipe(Effect.flip)
      expect(error).toBeInstanceOf(EmbeddingShapeError)
    }),
  )
})

describe("cosine", () => {
  it("is 1 for equal directions, 0 for orthogonal, -1 for opposite", () => {
    expect(cosine([2, 0], [5, 0])).toBeCloseTo(1, 10)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
    expect(cosine([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10)
  })

  it("accepts Float32Array and returns 0 for a zero vector", () => {
    expect(cosine(new Float32Array([1, 1]), [1, 1])).toBeCloseTo(1, 6)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it("returns NaN for different lengths", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBeNaN()
  })
})

describe("EmbedderTest", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Embedder>) => effect.pipe(Effect.provide(EmbedderTest))

  it.effect("returns 1024-dim unit vectors", () =>
    run(
      Effect.gen(function* () {
        const embedder = yield* Embedder
        expect(embedder.dims).toBe(1024)
        const [vector] = yield* embedder.embed(["qualquer texto"])
        expect(vector).toHaveLength(1024)
        expect(cosine(vector ?? [], vector ?? [])).toBeCloseTo(1, 6)
      }),
    ),
  )

  it.effect("is deterministic and ignores case and extra whitespace", () =>
    run(
      Effect.gen(function* () {
        const embedder = yield* Embedder
        const [first] = yield* embedder.embed(["Olá  Mundo"])
        const [again] = yield* embedder.embed(["  olá mundo "])
        expect(again).toEqual(first)
      }),
    ),
  )

  it.effect("gives different vectors for different texts", () =>
    run(
      Effect.gen(function* () {
        const embedder = yield* Embedder
        const [a, b] = yield* embedder.embed(["alpha", "beta"])
        expect(cosine(a ?? [], b ?? [])).toBeLessThan(0.99)
      }),
    ),
  )

  it.effect("returns an empty list for an empty input", () =>
    run(
      Effect.gen(function* () {
        const embedder = yield* Embedder
        expect(yield* embedder.embed([])).toEqual([])
      }),
    ),
  )
})

// Fake Ollama /api/embed server on 127.0.0.1. The script decides each reply by attempt number.
interface RecordedRequest {
  readonly path: string
  readonly model: string
  readonly input: ReadonlyArray<string>
}
interface Reply {
  readonly status: number
  readonly body: unknown
}
type Script = (attempt: number, input: ReadonlyArray<string>) => Reply

const RequestBody = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.String),
})

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      data += chunk
    })
    request.on("end", () => resolve(data))
    request.on("error", reject)
  })

const okScript: Script = (_attempt, input) => ({
  status: 200,
  body: { model: "bge-m3", embeddings: input.map(markerVector) },
})

const startFakeOllama = (script: Script) =>
  new Promise<{ url: string; requests: Array<RecordedRequest>; close: () => Promise<void> }>(
    (resolve, reject) => {
      const requests: Array<RecordedRequest> = []
      const server = createServer((request, response) => {
        readBody(request).then((raw) => {
          const body = Schema.decodeUnknownSync(RequestBody)(JSON.parse(raw))
          const reply = script(requests.length, body.input)
          requests.push({ path: request.url ?? "", model: body.model, input: body.input })
          response.writeHead(reply.status, { "content-type": "application/json" })
          response.end(JSON.stringify(reply.body))
        }, reject)
      })
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resolve({
          url: `http://127.0.0.1:${port}`,
          requests,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections()
              server.close(() => done())
            }),
        })
      })
    },
  )

const withFakeOllama = (script: Script) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeOllama(script)),
    (server) => Effect.promise(() => server.close()),
  )

const embedWith = (baseUrl: string, texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const embedder = yield* Embedder
    return yield* embedder.embed(texts)
  }).pipe(Effect.provide(EmbedderOllamaLive({ baseUrl })))

describe("EmbedderOllamaLive", () => {
  it.live("posts one request to /api/embed with the bge-m3 model and normalizes the vectors", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(okScript)
      const vectors = yield* embedWith(`${server.url}/`, ["a", "b"])
      expect(server.requests).toEqual([{ path: "/api/embed", model: "bge-m3", input: ["a", "b"] }])
      expect(vectors).toHaveLength(2)
      expect(vectors[0]).toEqual(normalize(markerVector("a")))
      expect(vectors[1]).toEqual(normalize(markerVector("b")))
      expect(vectors[0]).toHaveLength(1024)
    }).pipe(Effect.scoped),
  )

  it.live("splits 70 texts into requests of 32, 32 and 6 and keeps the order", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(okScript)
      const texts = Array.from({ length: 70 }, (_, index) => `t${index}`)
      const vectors = yield* embedWith(server.url, texts)
      expect(server.requests.map((request) => request.input.length)).toEqual([32, 32, 6])
      expect(vectors).toHaveLength(70)
      expect(vectors[69]).toEqual(normalize(markerVector("t69")))
    }).pipe(Effect.scoped),
  )

  it.live("does not touch the network for an empty list", () =>
    Effect.gen(function* () {
      const vectors = yield* embedWith("http://127.0.0.1:1", [])
      expect(vectors).toEqual([])
    }),
  )

  it.live("retries a batch that fails once and then succeeds", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama((attempt, input) =>
        attempt === 0 ? { status: 500, body: { error: "busy" } } : okScript(attempt, input),
      )
      const vectors = yield* embedWith(server.url, ["x"])
      expect(server.requests).toHaveLength(2)
      expect(vectors).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("gives up after two retries with an http error", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(() => ({ status: 500, body: { error: "down" } }))
      const error = yield* embedWith(server.url, ["x"]).pipe(Effect.flip)
      expect(error).toBeInstanceOf(EmbedError)
      expect(error).toMatchObject({ reason: "http", status: 500 })
      expect(server.requests).toHaveLength(3)
    }).pipe(Effect.scoped),
  )

  it.live("rejects a response with the wrong number of vectors without retrying", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(() => ({ status: 200, body: { embeddings: [markerVector("a")] } }))
      const error = yield* embedWith(server.url, ["a", "b"]).pipe(Effect.flip)
      expect(error).toMatchObject({ reason: "shape" })
      expect(server.requests).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("rejects a vector that is not EMBED_DIMS long without retrying", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(() => ({
        status: 200,
        body: { embeddings: [Array.from({ length: 768 }, () => 1)] },
      }))
      const error = yield* embedWith(server.url, ["a"]).pipe(Effect.flip)
      expect(error).toMatchObject({ reason: "shape" })
      expect(server.requests).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("rejects a body that is not an embeddings payload", () =>
    Effect.gen(function* () {
      const server = yield* withFakeOllama(() => ({ status: 200, body: { unexpected: true } }))
      const error = yield* embedWith(server.url, ["a"]).pipe(Effect.flip)
      expect(error).toMatchObject({ reason: "decode" })
    }).pipe(Effect.scoped),
  )

  it.live("reports a transport error when nothing listens", () =>
    Effect.gen(function* () {
      const error = yield* embedWith("http://127.0.0.1:1", ["a"]).pipe(Effect.flip)
      expect(error).toMatchObject({ reason: "transport" })
    }),
  )
})
