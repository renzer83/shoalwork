import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { type Candidate, RankerLive } from "../../src/rank/ranker.js"
import type { Signal, Weights } from "../../src/rank/signals.js"

export const only = (signal: Signal): Weights => ({
  bm25: signal === "bm25" ? 1 : 0,
  cosine: signal === "cosine" ? 1 : 0,
  recency: signal === "recency" ? 1 : 0,
  imports: signal === "imports" ? 1 : 0,
  success: signal === "success" ? 1 : 0,
  proximity: signal === "proximity" ? 1 : 0,
})

// Ranker on a fresh migrated database; the SqlClient is exposed to seed rows.
export const rankerEnv = (weights?: Weights) => Layer.provideMerge(RankerLive({ weights }), withTempDb())

export const insertChunk = (repo: string, id: string, path: string, content = "const x = 1\n") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at)
      VALUES (${id}, ${repo}, ${path}, 1, 10, ${`sha-${id}`}, 'ts', '[]', ${content}, '2026-10-01T00:00:00.000Z')`
  })

export const chunk = (id: string, path: string, raw: Candidate["raw"] = {}): Candidate => ({
  id,
  kind: "chunk",
  path,
  text: `text of ${id}`,
  raw,
})
