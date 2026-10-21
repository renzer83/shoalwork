import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type Adjacency, addEdge, extractImportSpecifiers, resolveImport } from "./imports.js"

// Upper bound of chunks read to build the import graph of a repo.
export const MAX_GRAPH_CHUNKS = 20_000
const MAX_CACHED_REPOS = 8

const Chunks = Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String }))
const Paths = Schema.Array(Schema.Struct({ path: Schema.String }))
const Version = Schema.Array(Schema.Struct({ n: Schema.Int, at: Schema.NullOr(Schema.String) }))

const decodeChunks = Schema.decodeUnknownEffect(Chunks)
const decodePaths = Schema.decodeUnknownEffect(Paths)
const decodeVersion = Schema.decodeUnknownEffect(Version)

// Import graph of the indexed JS/TS files of a repo, built from the stored chunks (regex over the import syntax, until
// T-100 brings a parser). The graph of a repo is kept until its chunks change (row count or newest indexed_at).
export const makeGraphLoader = (sql: SqlClient) => {
  const cache = new Map<string, { readonly version: string; readonly adjacency: Adjacency }>()
  return (repo: string): Effect.Effect<Adjacency, SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const [state] = yield* decodeVersion(
        yield* sql`SELECT count(*) AS n, max(indexed_at) AS at FROM code_chunks WHERE repo = ${repo}`,
      )
      const version = `${state?.n ?? 0}:${state?.at ?? ""}`
      const cached = cache.get(repo)
      if (cached !== undefined && cached.version === version) return cached.adjacency
      const known = new Set(
        (yield* decodePaths(yield* sql`SELECT DISTINCT path FROM code_chunks WHERE repo = ${repo}`)).map(
          (row) => row.path,
        ),
      )
      const chunks = yield* decodeChunks(
        yield* sql`SELECT path, content FROM code_chunks
          WHERE repo = ${repo} AND lang IN ('ts', 'js') AND (instr(content, 'import') > 0 OR instr(content, 'require') > 0)
          ORDER BY path, start_line LIMIT ${MAX_GRAPH_CHUNKS}`,
      )
      const adjacency: Adjacency = new Map()
      for (const chunk of chunks) {
        for (const specifier of extractImportSpecifiers(chunk.content)) {
          const target = resolveImport(chunk.path, specifier, known)
          if (target !== undefined) addEdge(adjacency, chunk.path, target)
        }
      }
      if (cache.size >= MAX_CACHED_REPOS && !cache.has(repo)) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(repo, { version, adjacency })
      return adjacency
    })
}
