import { Effect, type Redacted, Redacted as RedactedApi, Schema } from "effect"
import {
  CHUNK_ID_PATTERN,
  CodeHit as CodeHitSchema,
  MemoryHit as MemoryHitSchema,
  ReefApiError,
  type ReefMcpDeps,
} from "./tools.js"

// The MCP process never opens the database: it asks the core over HTTP (02-architecture §9), so it runs in any Tank.
export interface ReefApiOptions {
  // Origin of the core, e.g. http://127.0.0.1:3000 (validated by the entrypoint).
  readonly baseUrl: string
  readonly token: Redacted.Redacted<string>
  readonly repo: string
  readonly bot: string
  // Injected in tests; defaults to the global fetch.
  readonly fetch?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 10_000
// Answers above this size are refused: a search result never needs more, and it bounds memory in the MCP process.
export const MAX_BODY_BYTES = 1_048_576

const decodeHits = Schema.decodeUnknownEffect(Schema.Array(CodeHitSchema))
const decodeChunk = Schema.decodeUnknownEffect(CodeHitSchema)
const decodeMemory = Schema.decodeUnknownEffect(Schema.Array(MemoryHitSchema))

// Every failure becomes a ReefApiError with a short reason. The response body and the token never go into it.
export const makeReefApi = (options: ReefApiOptions): ReefMcpDeps => {
  const doFetch = options.fetch ?? globalThis.fetch

  const getJson = (
    op: string,
    path: string,
    params: Record<string, string>,
  ): Effect.Effect<unknown, ReefApiError> =>
    Effect.gen(function* () {
      const url = new URL(path, options.baseUrl)
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          doFetch(url, {
            headers: { authorization: `Bearer ${RedactedApi.value(options.token)}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        catch: (cause) => new ReefApiError({ op, reason: networkReason(cause) }),
      })
      if (!response.ok) {
        return yield* Effect.fail(new ReefApiError({ op, reason: `HTTP ${response.status}` }))
      }
      const declared = Number(response.headers.get("content-length") ?? "0")
      if (declared > MAX_BODY_BYTES) {
        return yield* Effect.fail(new ReefApiError({ op, reason: "response too large" }))
      }
      const buffer = yield* Effect.tryPromise({
        try: (): Promise<ArrayBuffer> => response.arrayBuffer(),
        catch: (cause) => new ReefApiError({ op, reason: networkReason(cause) }),
      })
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return yield* Effect.fail(new ReefApiError({ op, reason: "response too large" }))
      }
      return yield* Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(buffer)),
        catch: () => new ReefApiError({ op, reason: "invalid JSON" }),
      })
    })

  const shapeError = (op: string) => () => new ReefApiError({ op, reason: "unexpected response shape" })

  return {
    searchCode: (q, k) =>
      getJson("search_code", "/reef/search", { repo: options.repo, q, k: String(k) }).pipe(
        Effect.flatMap((body) => decodeHits(body).pipe(Effect.mapError(shapeError("search_code")))),
      ),
    searchMemory: (q, k) =>
      getJson("search_memory", "/memory", { bot: options.bot, q, k: String(k) }).pipe(
        Effect.flatMap((body) => decodeMemory(body).pipe(Effect.mapError(shapeError("search_memory")))),
      ),
    // The id is checked before it becomes a path segment; the request carries no repo or bot parameter.
    readChunk: (id) =>
      CHUNK_ID_PATTERN.test(id)
        ? getJson("read_chunk", `/reef/chunk/${encodeURIComponent(id)}`, {}).pipe(
            Effect.flatMap((body) => decodeChunk(body).pipe(Effect.mapError(shapeError("read_chunk")))),
          )
        : Effect.fail(new ReefApiError({ op: "read_chunk", reason: "invalid chunk id" })),
  }
}

const networkReason = (cause: unknown): string => {
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return "timeout"
  }
  return "network error"
}
