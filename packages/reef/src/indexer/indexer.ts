import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { repoKeyOf } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { Embedder, EmbedderTest, type EmbedError } from "../embedder.js"
import { EmbeddingShapeError, encodeEmbedding } from "../rows.js"
import { type CodeChunk, chunkFile, MAX_CHUNK_CHARS } from "./chunk.js"
import { CodeChunkKey, CodeChunkRow } from "./rows.js"
import { CODE_SEARCH_DEFAULT_K, type CodeSearchHit, searchCodeChunks } from "./search.js"
import { langOf } from "./symbols.js"
import { listRepoFiles, originUrlOf, readIndexable, resolveRepoRoot, type WalkError } from "./walk.js"

export interface IndexOptions {
  // Stable repo id stored with each chunk. Wins over repoUrl and the origin remote.
  readonly repo?: string | undefined
  // The repo's url in any form repoKeyOf reads (https, ssh, scp-like). Its key is the stored repo id.
  readonly repoUrl?: string | undefined
}

// The id a run stores its chunks under: `repo`, else the key of `repoUrl`, else the key of the origin remote of the
// directory (the same key the Lead's MCP scope and briefing use). Only a directory with no remote at all falls back to
// its absolute path, because no url names it.
const repoIdOf = (repoDir: string, options: IndexOptions): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (options.repo !== undefined) return options.repo
    if (options.repoUrl !== undefined) return repoKeyOf(options.repoUrl)
    const origin = yield* originUrlOf(repoDir)
    return origin === undefined ? resolve(repoDir) : repoKeyOf(origin)
  })

export interface IndexReport {
  readonly repo: string
  readonly files: number // indexable files seen in this run
  readonly filesChanged: number // files whose chunks were rewritten
  readonly filesRemoved: number // files whose chunks were deleted (gone, ignored or now excluded)
  readonly chunks: number // chunks of the repo after the run
  readonly chunksEmbedded: number // chunks that went through the Embedder in this run
  readonly chunksReused: number // chunks of changed files that kept their stored embedding
  // Files whose embedding failed: left as they were in the index, the rest of the run is unaffected.
  readonly failed: ReadonlyArray<IndexFailure>
}

export interface IndexFailure {
  readonly path: string
  readonly reason: string
}

export type IndexError = WalkError | SqlError | Schema.SchemaError
export type SearchError = EmbeddingShapeError | SqlError | Schema.SchemaError

export interface IndexerShape {
  readonly index: (repoDir: string, options?: IndexOptions) => Effect.Effect<IndexReport, IndexError>
  readonly search: (
    repo: string,
    query: string,
    k?: number,
  ) => Effect.Effect<ReadonlyArray<CodeSearchHit>, SearchError>
}

export class Indexer extends Context.Service<Indexer, IndexerShape>()("@shoalwork/Indexer") {}

export interface IndexerOptions {
  readonly maxFileBytes?: number | undefined
  // Upper bound of chunks scanned by the semantic leg of a search (most recently indexed first).
  readonly maxSemanticChunks?: number | undefined
}

const decodeKeys = Schema.decodeUnknownEffect(Schema.Array(CodeChunkKey))
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CodeChunkRow))

// Same ranges and hashes in the same order: the file needs no work at all.
const sameLayout = (stored: ReadonlyArray<CodeChunkKey>, chunks: ReadonlyArray<CodeChunk>): boolean =>
  stored.length === chunks.length &&
  stored.every((row, index) => {
    const chunk = chunks[index]
    return (
      chunk !== undefined &&
      row.has_embedding === 1 &&
      row.start_line === chunk.startLine &&
      row.end_line === chunk.endLine &&
      row.sha256 === chunk.sha256
    )
  })

interface Prepared {
  readonly id: string
  readonly chunk: CodeChunk
  readonly embedding: Uint8Array | null
}

export const IndexerLive = (
  options: IndexerOptions = {},
): Layer.Layer<Indexer, never, SqlClient | Embedder> =>
  Layer.effect(
    Indexer,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const embedder = yield* Embedder

      const deletePath = (repo: string, path: string) =>
        sql`DELETE FROM code_chunks WHERE repo = ${repo} AND path = ${path}`

      // Rewrites one file's chunks. Embeddings are kept for chunks whose sha256 is already stored under the same
      // path (a function that only moved lines is not embedded again); everything else is embedded in one call.
      const rewriteFile = (
        repo: string,
        path: string,
        chunks: ReadonlyArray<CodeChunk>,
      ): Effect.Effect<
        { readonly embedded: number; readonly reused: number },
        EmbedError | EmbeddingShapeError | SqlError | Schema.SchemaError
      > =>
        Effect.gen(function* () {
          const lang = langOf(path)
          const old = yield* decodeRows(
            yield* sql`SELECT * FROM code_chunks WHERE repo = ${repo} AND path = ${path} ORDER BY start_line`,
          )
          const pool = new Map<string, Array<{ readonly id: string; readonly embedding: Uint8Array }>>()
          for (const row of old) {
            if (row.embedding !== null) {
              const list = pool.get(row.sha256) ?? []
              list.push({ id: row.id, embedding: row.embedding })
              pool.set(row.sha256, list)
            }
          }
          const prepared: Array<Prepared> = chunks.map((chunk) => {
            const kept = pool.get(chunk.sha256)?.shift()
            return { id: kept?.id ?? `chk_${randomUUID()}`, chunk, embedding: kept?.embedding ?? null }
          })
          const missing = prepared.filter((entry) => entry.embedding === null)
          // The path leads the embedded text so a query naming a file lands near its chunks.
          const vectors = yield* embedder.embed(
            missing.map((entry) => `${path}\n${entry.chunk.content}`.slice(0, MAX_CHUNK_CHARS)),
          )
          const fresh = new Map<string, Uint8Array>()
          for (const [index, entry] of missing.entries()) {
            const vector = vectors[index]
            if (vector === undefined) {
              return yield* Effect.fail(
                new EmbeddingShapeError({
                  detail: `embedder returned ${vectors.length} vectors for ${missing.length} texts`,
                }),
              )
            }
            fresh.set(entry.id, yield* encodeEmbedding(vector))
          }
          const indexedAt = nowIso()
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* deletePath(repo, path)
              for (const entry of prepared) {
                const embedding = entry.embedding ?? fresh.get(entry.id) ?? null
                yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, embedding, indexed_at)
                  VALUES (${entry.id}, ${repo}, ${path}, ${entry.chunk.startLine}, ${entry.chunk.endLine}, ${entry.chunk.sha256},
                    ${lang}, ${JSON.stringify(entry.chunk.symbols)}, ${entry.chunk.content}, ${embedding}, ${indexedAt})`
              }
            }),
          )
          return { embedded: missing.length, reused: prepared.length - missing.length }
        })

      const index = (
        repoDir: string,
        indexOptions: IndexOptions = {},
      ): Effect.Effect<IndexReport, IndexError> =>
        Effect.gen(function* () {
          const root = yield* resolveRepoRoot(repoDir)
          const repo = yield* repoIdOf(repoDir, indexOptions)
          const paths = yield* listRepoFiles(root)
          const storedRows = yield* decodeKeys(
            yield* sql`SELECT id, path, start_line, end_line, sha256, embedding IS NOT NULL AS has_embedding
              FROM code_chunks WHERE repo = ${repo} ORDER BY path, start_line`,
          )
          const byPath = new Map<string, Array<CodeChunkKey>>()
          for (const row of storedRows) {
            const list = byPath.get(row.path) ?? []
            list.push(row)
            byPath.set(row.path, list)
          }

          let files = 0
          let filesChanged = 0
          let embedded = 0
          let reused = 0
          const failed: Array<IndexFailure> = []
          const seen = new Set<string>()
          for (const path of paths) {
            const content = yield* readIndexable(root, path, options)
            if (content === null) {
              continue
            }
            files++
            seen.add(path)
            const chunks = chunkFile(langOf(path), content)
            if (sameLayout(byPath.get(path) ?? [], chunks)) {
              continue
            }
            const result = yield* rewriteFile(repo, path, chunks).pipe(
              Effect.catchTags({
                EmbedError: (error) => Effect.succeed(`embed ${error.reason}: ${error.detail}`),
                EmbeddingShapeError: (error) => Effect.succeed(`embedding shape: ${error.detail}`),
              }),
            )
            if (typeof result === "string") {
              failed.push({ path, reason: result.slice(0, 300) })
              continue
            }
            filesChanged++
            embedded += result.embedded
            reused += result.reused
          }

          const gone = [...byPath.keys()].filter((path) => !seen.has(path))
          if (gone.length > 0) {
            yield* sql.withTransaction(
              Effect.forEach(gone, (path) => deletePath(repo, path), { discard: true }),
            )
          }
          const [total] = yield* sql<{
            readonly n: number
          }>`SELECT count(*) AS n FROM code_chunks WHERE repo = ${repo}`
          return {
            repo,
            files,
            filesChanged,
            filesRemoved: gone.length,
            chunks: total?.n ?? 0,
            chunksEmbedded: embedded,
            chunksReused: reused,
            failed,
          }
        })

      const search = (repo: string, query: string, k: number = CODE_SEARCH_DEFAULT_K) =>
        searchCodeChunks(repo, query, k, { maxSemanticChunks: options.maxSemanticChunks }).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.provideService(Embedder, embedder),
        )

      return { index, search }
    }),
  )

// No network: deterministic vectors from EmbedderTest.
export const IndexerTest = (options: IndexerOptions = {}): Layer.Layer<Indexer, never, SqlClient> =>
  IndexerLive(options).pipe(Layer.provide(EmbedderTest))
