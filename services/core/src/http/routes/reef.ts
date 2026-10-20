import { NotFound, SchemaViolation } from "@shoalwork/contracts"
import { CODE_SEARCH_DEFAULT_K, Indexer, SymbolList } from "@shoalwork/reef"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Context, Hono } from "hono"
import { type Principal, principalOf, type RunMcp, ScopeViolation } from "../principal.js"
import { failureResponse, type RouteResponse, sendResponse, UNAUTHORIZED } from "./respond.js"

// Chunk ids are minted by the indexer as `chk_<uuid v4>`; anything else never reaches the database.
const CHUNK_ID = /^chk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_SEARCH_K = 20
const MAX_QUERY_CHARS = 1024

// What the MCP server decodes (packages/reef/src/mcp/tools.ts CodeHit). Embeddings never leave the core.
export interface CodeHitView {
  readonly id: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly lang: string
  readonly symbols: ReadonlyArray<string>
  readonly content: string
  readonly score: number
}

const ChunkRow = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  start_line: Schema.Int,
  end_line: Schema.Int,
  lang: Schema.String,
  symbols: SymbolList,
  content: Schema.String,
})
const decodeChunks = Schema.decodeUnknownEffect(Schema.Array(ChunkRow))

const parseK = (raw: string | undefined): Effect.Effect<number, SchemaViolation> => {
  if (raw === undefined) {
    return Effect.succeed(CODE_SEARCH_DEFAULT_K)
  }
  const k = Number(raw)
  return Number.isInteger(k) && k >= 1 && k <= MAX_SEARCH_K
    ? Effect.succeed(k)
    : Effect.fail(
        new SchemaViolation({ where: "reef.search.k", issue: `k must be an integer 1..${MAX_SEARCH_K}` }),
      )
}

// An execution token searches its own repo only; an API caller must name the repo.
const repoFor = (
  principal: Principal,
  requested: string | undefined,
): Effect.Effect<string, SchemaViolation | ScopeViolation> => {
  if (principal.kind === "execution") {
    return requested === undefined || requested === principal.scope.repo
      ? Effect.succeed(principal.scope.repo)
      : Effect.fail(new ScopeViolation({ where: "reef.search.repo" }))
  }
  return requested === undefined || requested.trim() === ""
    ? Effect.fail(new SchemaViolation({ where: "reef.search.repo", issue: "repo is required" }))
    : Effect.succeed(requested)
}

const toView = (hit: {
  readonly id: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly lang: string
  readonly symbols: ReadonlyArray<string>
  readonly content: string
  readonly score: number
}): CodeHitView => ({
  id: hit.id,
  path: hit.path,
  startLine: hit.startLine,
  endLine: hit.endLine,
  lang: hit.lang,
  symbols: hit.symbols,
  content: hit.content,
  score: hit.score,
})

// GET /reef/search?repo=<repo>&q=<text>&k=<1..20, default 6> → bare array of CodeHitView (best first).
const searchRoute = (c: Context): Effect.Effect<RouteResponse, never, Indexer | SqlClient> => {
  const principal = principalOf(c.req.raw)
  if (principal === undefined) {
    return Effect.succeed(UNAUTHORIZED)
  }
  return Effect.gen(function* () {
    const q = c.req.query("q") ?? ""
    if (q.trim() === "" || q.length > MAX_QUERY_CHARS) {
      return yield* Effect.fail(
        new SchemaViolation({ where: "reef.search.q", issue: `q must be 1..${MAX_QUERY_CHARS} characters` }),
      )
    }
    const k = yield* parseK(c.req.query("k"))
    const repo = yield* repoFor(principal, c.req.query("repo"))
    const indexer = yield* Indexer
    const hits = yield* indexer.search(repo, q, k)
    return { status: 200, body: hits.map(toView) } satisfies RouteResponse
  }).pipe(
    Effect.catchTag("EmbeddingShapeError", (error) =>
      Effect.logError("reef search: embedding shape", error.detail).pipe(
        Effect.as({ status: 500, body: { error: "search unavailable" } } satisfies RouteResponse),
      ),
    ),
    Effect.catch((error) => failureResponse(error)),
  )
}

// GET /reef/chunk/:id → one CodeHitView. The score is 1: the chunk was named, not ranked.
const chunkRoute = (c: Context, id: string): Effect.Effect<RouteResponse, never, SqlClient> => {
  const principal = principalOf(c.req.raw)
  if (principal === undefined) {
    return Effect.succeed(UNAUTHORIZED)
  }
  return Effect.gen(function* () {
    if (!CHUNK_ID.test(id)) {
      return yield* Effect.fail(new SchemaViolation({ where: "reef.chunk.id", issue: "not a chunk id" }))
    }
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT id, repo, path, start_line, end_line, lang, symbols, content
      FROM code_chunks WHERE id = ${id}`
    const [row] = yield* decodeChunks(rows).pipe(Effect.orDie)
    // An execution token gets the same answer for a missing chunk and for another repo's chunk: no existence oracle.
    if (row === undefined) {
      return yield* Effect.fail(
        principal.kind === "execution"
          ? new ScopeViolation({ where: "reef.chunk" })
          : new NotFound({ entity: "code_chunk", id }),
      )
    }
    if (principal.kind === "execution" && row.repo !== principal.scope.repo) {
      return yield* Effect.fail(new ScopeViolation({ where: "reef.chunk" }))
    }
    return {
      status: 200,
      body: toView({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        lang: row.lang,
        symbols: row.symbols,
        content: row.content,
        score: 1,
      }),
    } satisfies RouteResponse
  }).pipe(Effect.catch((error) => failureResponse(error)))
}

export const registerReefRoutes = (app: Hono, runMcp: RunMcp): void => {
  app.get("/reef/search", async (c) => sendResponse(c, await runMcp(searchRoute(c))))
  app.get("/reef/chunk/:id", async (c) => sendResponse(c, await runMcp(chunkRoute(c, c.req.param("id")))))
}
