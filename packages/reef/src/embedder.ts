import { Context, Data, Effect, Layer, Schedule, Schema } from "effect"
import { EMBED_DIMS } from "./rows.js"

export const OLLAMA_EMBED_MODEL = "bge-m3"
// Ollama accepts larger inputs; the batch size bounds one request, not the caller's list.
const BATCH_SIZE = 32
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_TIMES = 2
const RETRY_BASE = "250 millis"

// reason "timeout" | "transport" | "http" | "decode" are transient and retried; "shape" is not.
export class EmbedError extends Data.TaggedError("EmbedError")<{
  readonly reason: "timeout" | "transport" | "http" | "decode" | "shape"
  readonly status?: number | undefined
  readonly detail: string
}> {}

export interface EmbedderShape {
  readonly dims: number
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>
}

export class Embedder extends Context.Service<Embedder, EmbedderShape>()("@shoalwork/Embedder") {}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// L2 normalization: stored vectors are unit length, so cosine is a plain dot product.
export const normalize = (vector: ReadonlyArray<number>): Array<number> => {
  let sum = 0
  for (const value of vector) {
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  return norm === 0 ? [...vector] : vector.map((value) => value / norm)
}

// Returns NaN for different lengths (a caller bug: stored and query vectors are both EMBED_DIMS) and 0 for zero vectors.
export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  if (a.length !== b.length) {
    return Number.NaN
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

const OllamaEmbedResponse = Schema.Struct({
  embeddings: Schema.Array(Schema.Array(Schema.Number)),
})
const decodeOllamaResponse = Schema.decodeUnknownEffect(OllamaEmbedResponse)

const isTimeout = (cause: unknown): boolean => cause instanceof Error && cause.name === "TimeoutError"

const shapeError = (detail: string): EmbedError => new EmbedError({ reason: "shape", detail })

// One request for one batch. Checks count and dimensions before returning anything to the caller.
const postBatch = (
  endpoint: string,
  model: string,
  batch: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        }),
      catch: (cause) =>
        new EmbedError({
          reason: isTimeout(cause) ? "timeout" : "transport",
          detail: messageOf(cause),
        }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new EmbedError({ reason: "http", status: response.status, detail: `HTTP ${response.status}` }),
      )
    }
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new EmbedError({ reason: "decode", detail: messageOf(cause) }),
    })
    const body = yield* decodeOllamaResponse(json).pipe(
      Effect.mapError((cause) => new EmbedError({ reason: "decode", detail: cause.message })),
    )
    if (body.embeddings.length !== batch.length) {
      return yield* Effect.fail(
        shapeError(`expected ${batch.length} embeddings, got ${body.embeddings.length}`),
      )
    }
    for (const vector of body.embeddings) {
      if (vector.length !== EMBED_DIMS) {
        return yield* Effect.fail(shapeError(`expected ${EMBED_DIMS} dims, got ${vector.length}`))
      }
    }
    return body.embeddings.map(normalize)
  })

const withRetry = <A>(effect: Effect.Effect<A, EmbedError>): Effect.Effect<A, EmbedError> =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential(RETRY_BASE),
      times: RETRY_TIMES,
      while: (error) => error.reason !== "shape",
    }),
  )

const embedWithOllama =
  (endpoint: string, model: string) =>
  (texts: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError> => {
    if (texts.length === 0) {
      return Effect.succeed([])
    }
    const batches: Array<ReadonlyArray<string>> = []
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      batches.push(texts.slice(start, start + BATCH_SIZE))
    }
    return Effect.forEach(batches, (batch) => withRetry(postBatch(endpoint, model, batch))).pipe(
      Effect.map((groups) => groups.flat()),
    )
  }

export interface EmbedderOllamaOptions {
  readonly baseUrl: string
  readonly model?: string | undefined
}

// Ollama /api/embed. The caller passes the URL; this package never reads process.env.
export const EmbedderOllamaLive = (options: EmbedderOllamaOptions): Layer.Layer<Embedder> => {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/embed`
  const model = options.model ?? OLLAMA_EMBED_MODEL
  return Layer.succeed(Embedder, { dims: EMBED_DIMS, embed: embedWithOllama(endpoint, model) })
}

// FNV-1a 32-bit: seed for the test vector generator.
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// Deterministic unit vector from the normalized text (mulberry32 stream seeded by FNV-1a).
export const testVector = (text: string): Array<number> => {
  const key = text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ")
  let state = fnv1a(key)
  const raw: Array<number> = []
  for (let index = 0; index < EMBED_DIMS; index++) {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    raw.push((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1)
  }
  return normalize(raw)
}

// No network: same text gives the same vector.
export const EmbedderTest: Layer.Layer<Embedder> = Layer.succeed(Embedder, {
  dims: EMBED_DIMS,
  embed: (texts) => Effect.succeed(texts.map(testVector)),
})
