import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { cosine, Embedder } from "../embedder.js"
import { ageDaysOf, recencySignal } from "../rank/signals.js"
import { decodeEmbedding, type EmbeddingShapeError } from "../rows.js"
import { CodeChunkRow, SymbolList } from "./rows.js"

export const CODE_SEARCH_DEFAULT_K = 6
export const RRF_K = 60
export const SYMBOL_BOOST = 1.5
const CANDIDATES = 50
// Candidates handed to the ranker (T-096).
export const RANK_CANDIDATES = 40
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
  // bm25 score (higher is better) for the lexical list.
  readonly score?: number
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
    return yield* sql<Candidate>`SELECT c.id AS id, c.symbols AS symbols, -bm25(code_fts, 1.0, 0.7, 2.0) AS score
      FROM code_fts JOIN code_chunks c ON c.rowid = code_fts.rowid
      WHERE code_fts MATCH ${match} AND c.repo = ${repo}
      ORDER BY bm25(code_fts, 1.0, 0.7, 2.0) LIMIT ${CANDIDATES}`
  })

// Repos already reported as over the semantic cap: the warning is logged once per repo and process.
const cappedRepos = new Set<string>()

// Brute-force cosine over the most recently indexed chunks of the repo, at most `limit` of them.
interface Semantic {
  readonly list: ReadonlyArray<Candidate>
  readonly vector: ReadonlyArray<number> | undefined
}

const NO_SEMANTIC: Semantic = { list: [], vector: undefined }

const semanticRanking = (
  repo: string,
  query: string,
  limit: number,
): Effect.Effect<Semantic, SqlError | EmbeddingShapeError, SqlClient | Embedder> =>
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
      return NO_SEMANTIC
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
      return NO_SEMANTIC
    }
    const scored: Array<{ readonly candidate: Candidate; readonly score: number }> = []
    for (const row of rows) {
      const embedding = yield* decodeEmbedding(row.embedding)
      scored.push({ candidate: { id: row.id, symbols: row.symbols }, score: cosine(vector, embedding) })
    }
    const list = scored
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES)
      .map((entry) => entry.candidate)
    return { list, vector }
  })

interface Fused {
  readonly id: string
  readonly score: number
  readonly boosted: boolean
}

// RRF over both lists, x1.5 for chunks whose symbols the query names; best first, ties by id.
const fuseCandidates = (
  query: string,
  lexical: ReadonlyArray<Candidate>,
  semantic: ReadonlyArray<Candidate>,
): Effect.Effect<ReadonlyArray<Fused>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const fused = reciprocalRankFusion([lexical.map((c) => c.id), semantic.map((c) => c.id)])
    const symbolsOf = new Map<string, string>()
    for (const candidate of [...semantic, ...lexical]) {
      symbolsOf.set(candidate.id, candidate.symbols)
    }
    const ranked: Array<Fused> = []
    for (const [id, base] of fused) {
      const symbols = yield* decodeSymbols(symbolsOf.get(id) ?? "[]")
      const boosted = matchesSymbol(query, symbols)
      ranked.push({ id, score: boosted ? base * SYMBOL_BOOST : base, boosted })
    }
    ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    return ranked
  })

const toHit = (row: CodeChunkRow, fused: Fused): CodeSearchHit => ({
  id: row.id,
  path: row.path,
  startLine: row.start_line,
  endLine: row.end_line,
  lang: row.lang,
  symbols: row.symbols,
  content: row.content,
  score: fused.score,
  boosted: fused.boosted,
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
    const ranked = yield* fuseCandidates(query, lexical, semantic.list)

    const hits: Array<CodeSearchHit> = []
    for (const entry of ranked.slice(0, k)) {
      const rows = yield* decodeChunks(yield* sql`SELECT * FROM code_chunks WHERE id = ${entry.id}`)
      const [row] = rows
      if (row === undefined) {
        continue
      }
      hits.push(toHit(row, entry))
    }
    return hits
  })

// A search hit with the signals the ranker combines, as the search measured them (not normalized).
export interface CodeCandidate {
  readonly hit: CodeSearchHit
  readonly raw: Partial<Record<"bm25" | "cosine" | "recency", number>>
}

// Raw candidates for the ranker (T-096): the best `limit` of the same fusion searchCodeChunks does, each with its
// own bm25 (when the lexical leg found it), cosine to the query (when it has an embedding and the embedder answered)
// and recency (exp(-days since the file's last commit / 30), when that commit time is known).
export const searchCodeCandidates = (
  repo: string,
  query: string,
  limit: number = RANK_CANDIDATES,
  options: SearchOptions = {},
): Effect.Effect<
  ReadonlyArray<CodeCandidate>,
  SqlError | EmbeddingShapeError | Schema.SchemaError,
  SqlClient | Embedder
> =>
  Effect.gen(function* () {
    if (limit <= 0 || queryTokens(query).length === 0) {
      return []
    }
    const sql = yield* SqlClient
    const lexical = yield* lexicalRanking(repo, query)
    const semantic = yield* semanticRanking(repo, query, options.maxSemanticChunks ?? MAX_SEMANTIC_CHUNKS)
    const top = (yield* fuseCandidates(query, lexical, semantic.list)).slice(0, limit)
    if (top.length === 0) {
      return []
    }
    const rows = yield* decodeChunks(
      yield* sql`SELECT * FROM code_chunks WHERE ${sql.in(
        "id",
        top.map((entry) => entry.id),
      )}`,
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    const bm25 = new Map(lexical.map((c) => [c.id, c.score]))
    const now = yield* Clock.currentTimeMillis
    const candidates: Array<CodeCandidate> = []
    for (const entry of top) {
      const row = byId.get(entry.id)
      if (row === undefined) {
        continue
      }
      const raw: { bm25?: number; cosine?: number; recency?: number } = {}
      const lexicalScore = bm25.get(row.id)
      if (lexicalScore !== undefined && Number.isFinite(lexicalScore)) {
        raw.bm25 = lexicalScore
      }
      if (semantic.vector !== undefined && row.embedding !== null) {
        const similarity = cosine(semantic.vector, yield* decodeEmbedding(row.embedding))
        if (Number.isFinite(similarity)) {
          raw.cosine = similarity
        }
      }
      const age = ageDaysOf(row.last_commit_at, now)
      if (age !== undefined) {
        raw.recency = recencySignal(age)
      }
      candidates.push({ hit: toHit(row, entry), raw })
    }
    return candidates
  })
