import { Effect, Schema, Struct } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"
import { type EmbedderShape, EmbedError, normalize } from "./embedder.js"
import { EMBED_DIMS, type MemoryKind, MemoryRow, type MemoryScope } from "./rows.js"

// Each ranked list (bm25, cosine) contributes at most this many candidates to the fusion.
export const LIST_LIMIT = 20
// RRF damping constant from the original paper; keeps a rank-1 hit from dwarfing a rank-5 hit.
export const RRF_K = 60
export const DEFAULT_K = 8
export const MAX_K = 100
// PROVISIONAL: cosine below this is dropped from the semantic list. 0.25 is a guess for bge-m3; it is
// recalibrated against the live model in T-166. Override per layer with ReefLive({ semanticFloor }).
export const DEFAULT_SEMANTIC_FLOOR = 0.25
// Brute-force cosine runs over this many most recent live embeddings per query (no ANN index yet).
export const MAX_VECTOR_CANDIDATES = 5000
const MAX_FTS_TOKENS = 32
const VECTOR_BYTES = EMBED_DIMS * 4

export interface ScopeRef {
  readonly scope: MemoryScope
  readonly ownerId: string
}

export interface SearchOptions {
  readonly scopes: ReadonlyArray<ScopeRef>
  readonly kinds?: ReadonlyArray<MemoryKind> | undefined
  readonly k?: number | undefined
}

// What the Reef hands out: the stored row without the 4 KB embedding blob.
export const MemoryItemRow = MemoryRow.mapFields(Struct.omit(["embedding"]))
export type MemoryItem = typeof MemoryItemRow.Type
export type Scored = MemoryItem & { readonly score: number }

export const MEMORY_COLUMNS =
  "id, scope, owner_id, kind, content, source, confidence, created_at, superseded_by, tombstone"

// User text becomes a list of quoted terms joined by OR. Quoting turns FTS5 syntax (NEAR, AND, NOT, *, -, ^,
// column filters, parentheses) into plain tokens, so nothing the user types can change the query structure.
export const toFtsQuery = (q: string): string | undefined => {
  const tokens = q.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []
  const unique = [...new Set(tokens.map((token) => token.toLowerCase()))].slice(0, MAX_FTS_TOKENS)
  return unique.length === 0 ? undefined : unique.map((token) => `"${token}"`).join(" OR ")
}

// Reciprocal Rank Fusion: score(id) = sum over lists of 1 / (RRF_K + rank), rank starting at 1.
export const fuse = (lists: ReadonlyArray<ReadonlyArray<string>>): ReadonlyMap<string, number> => {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return scores
}

const IdRow = Schema.Struct({ id: Schema.String })
const VectorRow = Schema.Struct({ id: Schema.String, embedding: Schema.instanceOf(Uint8Array) })
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow))
const decodeVectors = Schema.decodeUnknownEffect(Schema.Array(VectorRow))
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(MemoryItemRow))

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

// Stored vectors are float32 little-endian. The blob is copied to a fresh buffer (the driver's view may sit at
// an unaligned offset) and read as Float32Array; a big-endian host swaps through DataView instead.
const toFloat32 = (bytes: Uint8Array): Float32Array | undefined => {
  if (bytes.byteLength !== VECTOR_BYTES) {
    return undefined
  }
  const copy = bytes.slice()
  if (HOST_IS_LITTLE_ENDIAN) {
    return new Float32Array(copy.buffer, 0, EMBED_DIMS)
  }
  const view = new DataView(copy.buffer)
  const vector = new Float32Array(EMBED_DIMS)
  for (let index = 0; index < EMBED_DIMS; index++) {
    vector[index] = view.getFloat32(index * 4, true)
  }
  return vector
}

// Both sides are unit length (the Reef normalizes before storing, the query is normalized here), so cosine is a dot.
const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let index = 0; index < a.length; index++) {
    sum += (a[index] ?? 0) * (b[index] ?? 0)
  }
  return sum
}

const clampK = (k: number | undefined): number => {
  if (k === undefined || !Number.isFinite(k)) {
    return DEFAULT_K
  }
  return Math.min(MAX_K, Math.max(0, Math.floor(k)))
}

// Only live rows of the requested scopes/kinds. An empty scopes or kinds list matches nothing.
const filters = (sql: SqlClient, opts: SearchOptions): Fragment => {
  const clauses: Array<Fragment> = [
    sql`m.superseded_by IS NULL`,
    sql`m.tombstone = 0`,
    sql.or(opts.scopes.map((s) => sql`(m.scope = ${s.scope} AND m.owner_id = ${s.ownerId})`)),
  ]
  if (opts.kinds !== undefined) {
    clauses.push(sql.in("m.kind", opts.kinds))
  }
  return sql.and(clauses)
}

const lexicalIds = (
  sql: SqlClient,
  match: string,
  opts: SearchOptions,
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.gen(function* () {
    // bm25() is lower-is-better in SQLite, so ascending order puts the best match first.
    const rows = yield* sql`SELECT m.id AS id, bm25(memory_fts) AS r
      FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ${match} AND ${filters(sql, opts)}
      ORDER BY r, m.id LIMIT ${LIST_LIMIT}`
    const decoded = yield* decodeIds(rows).pipe(Effect.orDie)
    return decoded.map((row) => row.id)
  })

const semanticIds = (
  sql: SqlClient,
  query: Float32Array,
  opts: SearchOptions,
  floor: number,
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.gen(function* () {
    // Two steps: the inner query picks the candidate ids without touching the blobs; only those rows are read.
    const rows = yield* sql`SELECT id, embedding FROM memory_items
      WHERE embedding IS NOT NULL AND id IN (
        SELECT m.id FROM memory_items m WHERE ${filters(sql, opts)}
        ORDER BY m.created_at DESC, m.id LIMIT ${MAX_VECTOR_CANDIDATES})`
    const candidates = yield* decodeVectors(rows).pipe(Effect.orDie)
    const scored: Array<{ readonly id: string; readonly similarity: number }> = []
    let malformed = 0
    for (const candidate of candidates) {
      const vector = toFloat32(candidate.embedding)
      if (vector === undefined) {
        malformed++
        continue
      }
      const similarity = dot(query, vector)
      if (similarity >= floor) {
        scored.push({ id: candidate.id, similarity })
      }
    }
    if (malformed > 0) {
      yield* Effect.logWarning(
        `${malformed} memory embedding(s) are malformed and were skipped by semantic search`,
      )
    }
    scored.sort((a, b) => b.similarity - a.similarity || cmp(a.id, b.id))
    return scored.slice(0, LIST_LIMIT).map((entry) => entry.id)
  })

const loadItems = (
  sql: SqlClient,
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<MemoryItem>, SqlError> =>
  ids.length === 0
    ? Effect.succeed([])
    : Effect.gen(function* () {
        const rows =
          yield* sql`SELECT ${sql.literal(MEMORY_COLUMNS)} FROM memory_items WHERE ${sql.in("id", ids)}`
        return yield* decodeItems(rows).pipe(Effect.orDie)
      })

// The query vector must have the model's dimensionality; anything else cannot be compared to stored vectors.
const embedQuery = (embedder: EmbedderShape, q: string): Effect.Effect<Float32Array, EmbedError> =>
  Effect.gen(function* () {
    const [vector] = yield* embedder.embed([q])
    if (vector === undefined || vector.length !== EMBED_DIMS) {
      return yield* Effect.fail(
        new EmbedError({
          reason: "shape",
          detail: `expected ${EMBED_DIMS} dims, got ${vector === undefined ? "none" : vector.length}`,
        }),
      )
    }
    return Float32Array.from(normalize(vector))
  })

// Hybrid search: bm25 over FTS5 and cosine over the stored embeddings, fused with RRF. If the query cannot be
// embedded the search degrades to the lexical list (one warning, never the query text).
export const hybridSearch = (
  sql: SqlClient,
  embedder: EmbedderShape,
  q: string,
  opts: SearchOptions,
  semanticFloor: number = DEFAULT_SEMANTIC_FLOOR,
): Effect.Effect<ReadonlyArray<Scored>, SqlError> =>
  Effect.gen(function* () {
    const k = clampK(opts.k)
    if (k === 0 || opts.scopes.length === 0 || (opts.kinds !== undefined && opts.kinds.length === 0)) {
      return []
    }
    if (q.trim() === "") {
      return []
    }
    const match = toFtsQuery(q)
    const lexical = match === undefined ? [] : yield* lexicalIds(sql, match, opts)
    const queryVector = yield* embedQuery(embedder, q).pipe(
      Effect.catchTag("EmbedError", (error) =>
        Effect.logWarning(`query embedding failed (${error.reason}); falling back to lexical search`).pipe(
          Effect.as(undefined),
        ),
      ),
    )
    const semantic =
      queryVector === undefined ? [] : yield* semanticIds(sql, queryVector, opts, semanticFloor)
    const scores = fuse([lexical, semantic])
    const items = yield* loadItems(sql, [...scores.keys()])
    return items
      .map((item): Scored => ({ ...item, score: scores.get(item.id) ?? 0 }))
      .sort((a, b) => b.score - a.score || cmp(b.created_at, a.created_at) || cmp(a.id, b.id))
      .slice(0, k)
  })
