import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type Event, NotFound, SchemaViolation, type TaskId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { Embedder, type EmbedderShape, EmbedderTest, EmbedError, normalize } from "./embedder.js"
import { encodeEmbedding, type MemoryKind, type MemoryScope } from "./rows.js"
import {
  DEFAULT_K,
  DEFAULT_SEMANTIC_FLOOR,
  hybridSearch,
  MEMORY_COLUMNS,
  type MemoryItem,
  MemoryItemRow,
  type Scored,
  type SearchOptions,
} from "./search.js"
import { workingContext } from "./working.js"

export type { MemoryItem } from "./search.js"

export interface NewMemory {
  readonly scope: MemoryScope
  readonly ownerId: string
  readonly kind: MemoryKind
  readonly content: string
  readonly source: string
  readonly confidence?: number | undefined
}

// A successor never changes scope or owner: it inherits them from the item it replaces.
export type NextMemory = Omit<NewMemory, "scope" | "ownerId">

export interface ReefShape {
  // Fails with SchemaViolation when content/ownerId are empty, confidence is outside 0..1, or scope "global"
  // has an ownerId other than "global".
  readonly remember: (item: NewMemory) => Effect.Effect<MemoryItem, EmbedError | SchemaViolation | SqlError>
  // Live items only (not superseded, not forgotten), restricted to the given scopes. Empty scopes match nothing.
  // Never fails because of the embedder: without a query vector it answers from the lexical list alone.
  readonly search: (q: string, opts: SearchOptions) => Effect.Effect<ReadonlyArray<Scored>, SqlError>
  // Writes `next` in the scope of `id` and links `id` to it. NotFound also covers an item that is already
  // superseded or forgotten. To change owner: forget + remember.
  readonly supersede: (
    id: string,
    next: NextMemory,
  ) => Effect.Effect<MemoryItem, NotFound | EmbedError | SchemaViolation | SqlError>
  // Tombstone, never DELETE. Forgetting an already forgotten item is a no-op.
  readonly forget: (id: string) => Effect.Effect<void, NotFound | SqlError>
  // The whole chain the item belongs to, oldest first, including superseded and forgotten versions.
  readonly history: (id: string) => Effect.Effect<ReadonlyArray<MemoryItem>, SqlError>
  // Last n events of the task stream, oldest first.
  readonly workingContext: (taskId: TaskId, n: number) => Effect.Effect<ReadonlyArray<Event>, SqlError>
}

export class Reef extends Context.Service<Reef, ReefShape>()("@shoalwork/Reef") {}

export interface ReefOptions {
  // Cosine floor of the semantic list. Provisional until the live calibration in T-166.
  readonly semanticFloor?: number | undefined
}

const decodeItems = (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<MemoryItem>> =>
  Schema.decodeUnknownEffect(Schema.Array(MemoryItemRow))(rows).pipe(Effect.orDie)

const streamOf = (scope: MemoryScope, ownerId: string): string => `memory:${scope}:${ownerId}`

const invalid = (where: string, issue: string): Effect.Effect<never, SchemaViolation> =>
  Effect.fail(new SchemaViolation({ where: `reef.${where}`, issue }))

const validateNext = (item: NextMemory): Effect.Effect<void, SchemaViolation> => {
  if (item.content.trim() === "") {
    return invalid("content", "content must not be empty")
  }
  const confidence = item.confidence
  if (confidence !== undefined && !(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)) {
    return invalid("confidence", "confidence must be a finite number in 0..1")
  }
  return Effect.void
}

const validateNew = (item: NewMemory): Effect.Effect<void, SchemaViolation> => {
  if (item.ownerId.trim() === "") {
    return invalid("ownerId", "ownerId must not be empty")
  }
  if (item.scope === "global" && item.ownerId !== "global") {
    return invalid("ownerId", 'scope "global" requires ownerId "global"')
  }
  return validateNext(item)
}

const embedContent = (embedder: EmbedderShape, content: string): Effect.Effect<Uint8Array, EmbedError> =>
  Effect.gen(function* () {
    const [vector] = yield* embedder.embed([content])
    if (vector === undefined) {
      return yield* Effect.fail(new EmbedError({ reason: "shape", detail: "embedder returned no vector" }))
    }
    return yield* encodeEmbedding(normalize(vector)).pipe(
      Effect.mapError((e) => new EmbedError({ reason: "shape", detail: e.detail })),
    )
  })

const makeReef = (
  sql: SqlClient,
  embedder: EmbedderShape,
  beacon: BeaconShape,
  semanticFloor: number,
): ReefShape => {
  // A rejected memory event is a bug in this package (the payloads are built here), not a caller error.
  const emit = (
    type: "memory.added" | "memory.superseded" | "memory.forgotten",
    scope: MemoryScope,
    ownerId: string,
    id: string,
    payload: Record<string, unknown>,
  ): Effect.Effect<void, SqlError> =>
    beacon
      .append({
        streamId: streamOf(scope, ownerId),
        type,
        payload: { id, scope, ownerId, ...payload },
        actor: "reef",
        correlationId: id,
      })
      .pipe(
        Effect.catchTags({
          Conflict: (e) => Effect.die(e),
          SchemaViolation: (e) => Effect.die(e),
        }),
        Effect.asVoid,
      )

  const insert = (item: NewMemory, embedding: Uint8Array): Effect.Effect<MemoryItem, SqlError> =>
    Effect.gen(function* () {
      const id = `mem_${crypto.randomUUID()}`
      const rows = yield* sql`INSERT INTO memory_items
        (id, scope, owner_id, kind, content, source, confidence, created_at, embedding)
        VALUES (${id}, ${item.scope}, ${item.ownerId}, ${item.kind}, ${item.content}, ${item.source},
          ${item.confidence ?? 1}, ${nowIso()}, ${embedding})
        RETURNING ${sql.literal(MEMORY_COLUMNS)}`
      const [row] = yield* decodeItems(rows)
      if (row === undefined) {
        return yield* Effect.die("INSERT ... RETURNING produced no row")
      }
      yield* emit("memory.added", row.scope, row.owner_id, row.id, { kind: row.kind, source: row.source })
      return row
    })

  const remember: ReefShape["remember"] = (item) =>
    Effect.gen(function* () {
      yield* validateNew(item)
      const embedding = yield* embedContent(embedder, item.content)
      return yield* sql.withTransaction(insert(item, embedding))
    })

  const supersede: ReefShape["supersede"] = (id, next) =>
    Effect.gen(function* () {
      yield* validateNext(next)
      const embedding = yield* embedContent(embedder, next.content)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const found = yield* sql`SELECT ${sql.literal(MEMORY_COLUMNS)} FROM memory_items
            WHERE id = ${id} AND superseded_by IS NULL AND tombstone = 0`
          const [old] = yield* decodeItems(found)
          if (old === undefined) {
            return yield* Effect.fail(new NotFound({ entity: "memory_item", id }))
          }
          // Only the named fields are read from `next`: extra properties on the object are ignored.
          const created = yield* insert(
            {
              scope: old.scope,
              ownerId: old.owner_id,
              kind: next.kind,
              content: next.content,
              source: next.source,
              confidence: next.confidence,
            },
            embedding,
          )
          yield* sql`UPDATE memory_items SET superseded_by = ${created.id} WHERE id = ${id}`
          yield* emit("memory.superseded", old.scope, old.owner_id, old.id, { supersededBy: created.id })
          return created
        }),
      )
    })

  const forget: ReefShape["forget"] = (id) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* sql`SELECT ${sql.literal(MEMORY_COLUMNS)} FROM memory_items WHERE id = ${id}`
        const [row] = yield* decodeItems(found)
        if (row === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "memory_item", id }))
        }
        if (row.tombstone === 1) {
          return
        }
        yield* sql`UPDATE memory_items SET tombstone = 1 WHERE id = ${id}`
        yield* emit("memory.forgotten", row.scope, row.owner_id, row.id, {})
      }),
    )

  const byId = (id: string): Effect.Effect<MemoryItem | undefined, SqlError> =>
    sql`SELECT ${sql.literal(MEMORY_COLUMNS)} FROM memory_items WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeItems),
      Effect.map((rows) => rows[0]),
    )

  const predecessorOf = (id: string): Effect.Effect<MemoryItem | undefined, SqlError> =>
    sql`SELECT ${sql.literal(MEMORY_COLUMNS)} FROM memory_items WHERE superseded_by = ${id}`.pipe(
      Effect.flatMap(decodeItems),
      Effect.map((rows) => rows[0]),
    )

  const history: ReefShape["history"] = (id) =>
    Effect.gen(function* () {
      const start = yield* byId(id)
      if (start === undefined) {
        return []
      }
      // `seen` guards against a corrupted cycle; a healthy chain is linear.
      const seen = new Set<string>([start.id])
      const chain: Array<MemoryItem> = [start]
      for (let prev = yield* predecessorOf(start.id); prev !== undefined && !seen.has(prev.id); ) {
        seen.add(prev.id)
        chain.unshift(prev)
        prev = yield* predecessorOf(prev.id)
      }
      for (let next = start.superseded_by; next !== null && !seen.has(next); ) {
        seen.add(next)
        const row = yield* byId(next)
        if (row === undefined) {
          break
        }
        chain.push(row)
        next = row.superseded_by
      }
      return chain
    })

  return {
    remember,
    search: (q, opts) => hybridSearch(sql, embedder, q, { ...opts, k: opts.k ?? DEFAULT_K }, semanticFloor),
    supersede,
    forget,
    history,
    workingContext: (taskId, n) => workingContext(beacon, taskId, n),
  }
}

export const ReefLive = (
  options: ReefOptions = {},
): Layer.Layer<Reef, never, SqlClient | Embedder | Beacon> => {
  const floor = options.semanticFloor
  const semanticFloor = floor !== undefined && Number.isFinite(floor) ? floor : DEFAULT_SEMANTIC_FLOOR
  return Layer.effect(
    Reef,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const embedder = yield* Embedder
      const beacon = yield* Beacon
      return makeReef(sql, embedder, beacon, semanticFloor)
    }),
  )
}

// Same service over the deterministic embedder: no network. The caller supplies the db and the Beacon.
export const ReefTest: Layer.Layer<Reef, never, SqlClient | Beacon> = Layer.provide(ReefLive(), EmbedderTest)
