import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { cosine, Embedder } from "../embedder.js"
import { decodeEmbedding, type EmbeddingShapeError } from "../rows.js"
import { CodeChunkRow, SymbolList } from "./rows.js"

export const CODE_SEARCH_DEFAULT_K = 6
export const RRF_K = 60
export const SYMBOL_BOOST = 1.5
const CANDIDATES = 50
// Bounds on user text before it reaches FTS5 or the embedder.
export const MAX_QUERY_CHARS = 1024
export const MAX_QUERY_TOKENS = 32
export const MAX_SEMANTIC_CHUNKS = 20_000

export interface SearchOptions {
  readonly maxSemanticChunks?: number | undefined
}

export interface CodeSearchHit {
  readonly id: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly lang: string
  readonly symbols: ReadonlyArray<string>
  readonly content: string
  readonly score: number
  readonly boosted: boolean
}

export const queryTokens = (query: string): ReadonlyArray<string> =>
  (query.slice(0, MAX_QUERY_CHARS).match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, MAX_QUERY_TOKENS)

// Quoted tokens joined with OR: raw user text never reaches the FTS5 query grammar.
export const ftsMatchExpression = (query: string): string =>
  queryTokens(query)
    .map((token) => `"${token}"`)
    .join(" OR ")

// Reciprocal rank fusion over ranked id lists (best first).
export const reciprocalRankFusion = (rankings: ReadonlyArray<ReadonlyArray<string>>): Map<string, number> => {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return scores
}

// The query names a symbol of the chunk (case-insensitive, whole identifier).
export const matchesSymbol = (query: string, symbols: ReadonlyArray<string>): boolean => {
  if (symbols.length === 0) {
    return false
  }
  const wanted = new Set(queryTokens(query).map((token) => token.toLowerCase()))
  return symbols.some((symbol) => wanted.has(symbol.toLowerCase()))
}

const decodeSymbols = Schema.decodeUnknownEffect(SymbolList)
const decodeChunks = Schema.decodeUnknownEffect(Schema.Array(CodeChunkRow))

interface Candidate {
  readonly id: string
  readonly symbols: string
}

const lexicalRanking = (
  repo: string,
  query: string,
): Effect.Effect<ReadonlyArray<Candidate>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const match = ftsMatchExpression(query)
    if (match === "") {
      return []
    }
    const sql = yield* SqlClient
    // Column weights: content 1, path 0.7, symbols 2 (bm25 is lower-is-better, ORDER BY ascending).
    return yield* sql<Candidate>`SELECT c.id AS id, c.symbols AS symbols
      FROM code_fts JOIN code_chunks c ON c.rowid = code_fts.rowid
      WHERE code_fts MATCH ${match} AND c.repo = ${repo}
      ORDER BY bm25(code_fts, 1.0, 0.7, 2.0) LIMIT ${CANDIDATES}`
  })

// Repos already reported as over the semantic cap: the warning is logged once per repo and process.
const cappedRepos = new Set<string>()

// Brute-force cosine over the most recently indexed chunks of the repo, at most `limit` of them.
const semanticRanking = (
  repo: string,
  query: string,
  limit: number,
): Effect.Effect<ReadonlyArray<Candidate>, SqlError | EmbeddingShapeError, SqlClient | Embedder> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const embedder = yield* Embedder
    const stored = yield* sql<{
      readonly id: string
      readonly symbols: string
      readonly embedding: Uint8Array
    }>`SELECT id, symbols, embedding FROM code_chunks WHERE repo = ${repo} AND embedding IS NOT NULL
      ORDER BY indexed_at DESC, id LIMIT ${limit + 1}`
    if (stored.length === 0) {
      return []
    }
    if (stored.length > limit) {
      if (!cappedRepos.has(repo)) {
        cappedRepos.add(repo)
        yield* Effect.logWarning(
          `semantic search limited to the ${limit} most recently indexed chunks of ${repo}`,
        )
      }
    }
    const rows = stored.slice(0, limit)
    const [vector] = yield* embedder.embed([query.slice(0, MAX_QUERY_CHARS)]).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`semantic search skipped: ${error.reason}: ${error.detail}`),
      ),
      Effect.orElseSucceed(() => []),
    )
    if (vector === undefined) {
      return []
    }
    const scored: Array<{ readonly candidate: Candidate; readonly score: number }> = []
    for (const row of rows) {
      const embedding = yield* decodeEmbedding(row.embedding)
      scored.push({ candidate: { id: row.id, symbols: row.symbols }, score: cosine(vector, embedding) })
    }
    return scored
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES)
      .map((entry) => entry.candidate)
  })

// Hybrid search: FTS5 bm25 + cosine over stored embeddings, fused with RRF; x1.5 when the query names a symbol.
// If the embedder is down the semantic list is empty and the lexical list alone ranks (a warning is logged).
export const searchCodeChunks = (
  repo: string,
  query: string,
  k: number = CODE_SEARCH_DEFAULT_K,
  options: SearchOptions = {},
): Effect.Effect<
  ReadonlyArray<CodeSearchHit>,
  SqlError | EmbeddingShapeError | Schema.SchemaError,
  SqlClient | Embedder
> =>
  Effect.gen(function* () {
    if (k <= 0 || queryTokens(query).length === 0) {
      return []
    }
    const sql = yield* SqlClient
    const lexical = yield* lexicalRanking(repo, query)
    const semantic = yield* semanticRanking(repo, query, options.maxSemanticChunks ?? MAX_SEMANTIC_CHUNKS)
    const fused = reciprocalRankFusion([lexical.map((c) => c.id), semantic.map((c) => c.id)])
    const symbolsOf = new Map<string, string>()
    for (const candidate of [...semantic, ...lexical]) {
      symbolsOf.set(candidate.id, candidate.symbols)
    }
    const ranked: Array<{ readonly id: string; readonly score: number; readonly boosted: boolean }> = []
    for (const [id, base] of fused) {
      const symbols = yield* decodeSymbols(symbolsOf.get(id) ?? "[]")
      const boosted = matchesSymbol(query, symbols)
      ranked.push({ id, score: boosted ? base * SYMBOL_BOOST : base, boosted })
    }
    ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))

    const hits: Array<CodeSearchHit> = []
    for (const entry of ranked.slice(0, k)) {
      const rows = yield* decodeChunks(yield* sql`SELECT * FROM code_chunks WHERE id = ${entry.id}`)
      const [row] = rows
      if (row === undefined) {
        continue
      }
      hits.push({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        lang: row.lang,
        symbols: row.symbols,
        content: row.content,
        score: entry.score,
        boosted: entry.boosted,
      })
    }
    return hits
  })
