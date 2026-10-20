import { Data, Effect, Schema } from "effect"
import * as z from "zod/v4"

// Results are bounded so one tool call cannot flood the CLI's context: at most MAX_RESULTS items, each snippet cut
// at MAX_SNIPPET_CHARS, path/lang/symbols cut to their own limits. Embeddings never reach these types: the decoders
// below drop every field they do not name.
export const MAX_RESULTS = 6
export const MAX_SNIPPET_CHARS = 1200
export const MAX_PATH_CHARS = 512
export const MAX_LANG_CHARS = 32
export const MAX_SYMBOLS = 32
export const MAX_SYMBOL_CHARS = 128
export const DEFAULT_K = 6
export const MAX_QUERY_CHARS = 1024

// Chunk ids are minted by the indexer as `chk_<uuid v4>` (packages/reef/src/indexer/indexer.ts). Anything else,
// including `.` and `..`, is refused before it reaches a URL.
export const CHUNK_ID_PATTERN = /^chk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class ReefApiError extends Data.TaggedError("ReefApiError")<{
  readonly op: string
  readonly reason: string
}> {}

// Shapes the core answers with (GET /reef/search, GET /reef/chunk/:id, GET /memory).
export const CodeHit = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  lang: Schema.String,
  symbols: Schema.Array(Schema.String),
  content: Schema.String,
  score: Schema.Number,
})
export type CodeHit = typeof CodeHit.Type

export const MemoryHit = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["bot", "pod", "global"]),
  kind: Schema.Literals(["working", "episodic", "semantic", "procedural"]),
  content: Schema.String,
  score: Schema.Number,
})
export type MemoryHit = typeof MemoryHit.Type

export interface ReefMcpDeps {
  readonly searchCode: (q: string, k: number) => Effect.Effect<ReadonlyArray<CodeHit>, ReefApiError>
  readonly searchMemory: (q: string, k: number) => Effect.Effect<ReadonlyArray<MemoryHit>, ReefApiError>
  readonly readChunk: (id: string) => Effect.Effect<CodeHit, ReefApiError>
}

const kSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_RESULTS)
  .optional()
  .describe(`Number of hits to return, from 1 to ${MAX_RESULTS} (default ${DEFAULT_K}).`)

// Tool inputs, validated by the MCP SDK before the handler runs.
export const SearchCodeInput = z.object({
  q: z.string().min(2).max(MAX_QUERY_CHARS),
  k: kSchema,
})
export const SearchMemoryInput = z.object({
  q: z.string().min(2).max(MAX_QUERY_CHARS),
  k: kSchema,
})
export const ReadChunkInput = z.object({
  id: z.string().regex(CHUNK_ID_PATTERN, "id must be a chunk id returned by search_code"),
})

export type SnippetHit = {
  readonly id: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly lang: string
  readonly symbols: ReadonlyArray<string>
  readonly score: number
  readonly snippet: string
  readonly truncated: boolean
}

export type MemorySnippet = {
  readonly id: string
  readonly scope: MemoryHit["scope"]
  readonly kind: MemoryHit["kind"]
  readonly score: number
  readonly snippet: string
  readonly truncated: boolean
}

const cut = (text: string, limit: number): { readonly snippet: string; readonly truncated: boolean } =>
  text.length > limit
    ? { snippet: text.slice(0, limit), truncated: true }
    : { snippet: text, truncated: false }

export const toSnippetHit = (hit: CodeHit): SnippetHit => ({
  id: hit.id,
  path: hit.path.slice(0, MAX_PATH_CHARS),
  startLine: hit.startLine,
  endLine: hit.endLine,
  lang: hit.lang.slice(0, MAX_LANG_CHARS),
  symbols: hit.symbols.slice(0, MAX_SYMBOLS).map((symbol) => symbol.slice(0, MAX_SYMBOL_CHARS)),
  score: hit.score,
  ...cut(hit.content, MAX_SNIPPET_CHARS),
})

export const toMemorySnippet = (hit: MemoryHit): MemorySnippet => ({
  id: hit.id,
  scope: hit.scope,
  kind: hit.kind,
  score: hit.score,
  ...cut(hit.content, MAX_SNIPPET_CHARS),
})

const effectiveK = (k: number | undefined): number => Math.min(k ?? DEFAULT_K, MAX_RESULTS)

export const searchCodeTool = (
  deps: ReefMcpDeps,
  input: z.infer<typeof SearchCodeInput>,
): Effect.Effect<ReadonlyArray<SnippetHit>, ReefApiError> =>
  deps
    .searchCode(input.q, effectiveK(input.k))
    .pipe(Effect.map((hits) => hits.slice(0, MAX_RESULTS).map(toSnippetHit)))

export const searchMemoryTool = (
  deps: ReefMcpDeps,
  input: z.infer<typeof SearchMemoryInput>,
): Effect.Effect<ReadonlyArray<MemorySnippet>, ReefApiError> =>
  deps
    .searchMemory(input.q, effectiveK(input.k))
    .pipe(Effect.map((hits) => hits.slice(0, MAX_RESULTS).map(toMemorySnippet)))

export const readChunkTool = (
  deps: ReefMcpDeps,
  input: z.infer<typeof ReadChunkInput>,
): Effect.Effect<SnippetHit, ReefApiError> => deps.readChunk(input.id).pipe(Effect.map(toSnippetHit))
