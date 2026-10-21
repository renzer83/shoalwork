import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// The key of a summary: the hash of its scope (the summarizer and the counter that made it), its level and its text.
export const summaryKey = (scope: string, level: 2 | 3, text: string): string =>
  createHash("sha256").update(`${scope}\u0000${level}\u0000${text}`).digest("hex")

export interface SummaryEntry {
  readonly key: string
  readonly level: 2 | 3
  readonly summary: string
  readonly tokens: number
}

// Summaries reused across briefings (T-097). Reads and writes come in batches: one round trip per block, not per item.
// A cache that cannot answer is a miss, never a failure of the briefing.
export interface SummaryCache {
  // The summaries of the keys that are stored and not expired, by key.
  readonly getMany: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>
  readonly putMany: (entries: ReadonlyArray<SummaryEntry>) => Effect.Effect<void>
}

const MAX_MEMORY_ENTRIES = 512

// In-process cache: entries older than the TTL are misses and are dropped when the cache is written.
export const makeMemorySummaryCache = (options: {
  readonly ttlMs: number
  readonly now: () => number
}): SummaryCache => {
  const entries = new Map<string, { readonly summary: string; readonly at: number }>()
  const live = (at: number): boolean => options.now() - at <= options.ttlMs
  return {
    getMany: (keys) =>
      Effect.sync(() => {
        const found = new Map<string, string>()
        for (const key of keys) {
          const hit = entries.get(key)
          if (hit !== undefined && live(hit.at)) found.set(key, hit.summary)
        }
        return found
      }),
    putMany: (batch) =>
      Effect.sync(() => {
        for (const [key, hit] of entries) if (!live(hit.at)) entries.delete(key)
        const at = options.now()
        for (const entry of batch) {
          entries.delete(entry.key)
          entries.set(entry.key, { summary: entry.summary, at })
        }
        while (entries.size > MAX_MEMORY_ENTRIES) {
          const oldest = entries.keys().next()
          if (oldest.done === true) break
          entries.delete(oldest.value)
        }
      }),
  }
}

const Row = Schema.Struct({ hash: Schema.String, summary: Schema.String })
const RowsOf = Schema.Array(Row)

// A failing read or write is logged and treated as a miss: the summaries are simply made again.
const tolerate = <A>(what: string, fallback: A, effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
  effect.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`context summary ${what} failed`, String(cause)).pipe(Effect.as(fallback)),
    ),
  )

// The cache over context_summaries (0030). A read is one statement over the keys (json_each), a write is one statement
// that first deletes the rows past the TTL and then upserts the batch.
export const sqlSummaryCache = (
  ttlHours: number,
  now: () => number = () => Date.now(),
): Effect.Effect<SummaryCache, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const ttlMs = ttlHours * 60 * 60 * 1000
    const cutoff = (): string => new Date(now() - ttlMs).toISOString()
    return {
      getMany: (keys) => {
        if (keys.length === 0) return Effect.succeed(new Map<string, string>())
        const read = sql`SELECT hash, summary FROM context_summaries
          WHERE created_at >= ${cutoff()} AND hash IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`.pipe(
          Effect.flatMap((rows) => Schema.decodeUnknownEffect(RowsOf)(rows)),
          Effect.map(
            (rows): ReadonlyMap<string, string> => new Map(rows.map((row) => [row.hash, row.summary])),
          ),
        )
        return tolerate<ReadonlyMap<string, string>>("read", new Map(), read)
      },
      putMany: (entries) => {
        if (entries.length === 0) return Effect.void
        const createdAt = new Date(now()).toISOString()
        const batch = JSON.stringify(
          entries.map((entry) => ({
            hash: entry.key,
            level: entry.level,
            summary: entry.summary,
            tokens: entry.tokens,
            created_at: createdAt,
          })),
        )
        const write = sql`DELETE FROM context_summaries WHERE created_at < ${cutoff()}`.pipe(
          Effect.flatMap(
            () => sql`INSERT INTO context_summaries (hash, level, summary, tokens, created_at)
              SELECT json_extract(value, '$.hash'), json_extract(value, '$.level'), json_extract(value, '$.summary'),
                json_extract(value, '$.tokens'), json_extract(value, '$.created_at')
              FROM json_each(${batch}) WHERE true
              ON CONFLICT (hash) DO UPDATE SET level = excluded.level, summary = excluded.summary,
                tokens = excluded.tokens, created_at = excluded.created_at`,
          ),
          Effect.map((): void => undefined),
        )
        return tolerate<void>("write", undefined, write)
      },
    }
  })
