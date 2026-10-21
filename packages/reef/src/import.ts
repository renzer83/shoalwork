import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { type NotFound, SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { EmbedError } from "./embedder.js"
import { inspectFile, listMarkdown, type Outcome, resolveRoot, type SkippedFile } from "./import-walk.js"
import type { WalkError } from "./indexer/walk.js"
import { chunkMarkdown } from "./markdown.js"
import { Reef } from "./reef.js"
import { MemoryKind, type MemoryScope } from "./rows.js"

export type { SkippedFile, SkipReason } from "./import-walk.js"

const LABEL = /^[A-Za-z0-9._-]+$/
const PROGRESS_EVERY = 100
// source = `<label>:<relpath>#<index>:<sha8>`; the relpath may hold "#" or ":", so the tail is matched from the right.
const SOURCE_TAIL = /^(.*)#(\d+):([0-9a-f]{8})$/

export interface ImportOptions {
  // Absolute path of the directory to import. Nothing outside it is read, symlinks included.
  readonly dir: string
  readonly scope: MemoryScope
  // Owner id as stored: "global" for the global scope, the BotId for a bot. The core resolves names before calling.
  readonly ownerId: string
  readonly kind: MemoryKind
  // Label of this import; part of every source and the reconciliation namespace of (scope, owner). Letters, digits,
  // ".", "_" and "-" only.
  readonly source: string
  // Directory names pruned at any depth, on top of node_modules, .git and .obsidian. Same character set as source.
  readonly exclude?: ReadonlyArray<string>
}

export interface ImportReport {
  // Markdown files read and reconciled (a file with no chunks counts too).
  readonly files: number
  readonly chunks: number
  readonly created: number
  readonly superseded: number
  readonly unchanged: number
  readonly forgotten: number
  readonly skipped: ReadonlyArray<SkippedFile>
  // Paths whose content matched the secret check. Their content is never stored.
  readonly rejected: ReadonlyArray<string>
}

export type ImportError = WalkError | EmbedError | SchemaViolation | NotFound | SqlError

const sha8Of = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 8)

interface Chunk {
  readonly content: string
  readonly sha8: string
}

const LiveRow = Schema.Struct({ id: Schema.String, source: Schema.String, kind: MemoryKind })
const decodeLive = Schema.decodeUnknownEffect(Schema.Array(LiveRow))

interface LiveChunk {
  readonly id: string
  readonly sha8: string
  readonly kind: MemoryKind
}

// Live memories written by this label in this scope, grouped by relpath. Rows whose source does not carry the
// importer's tail are not ours and are left alone.
const liveChunksOf = (
  sql: SqlClient,
  scope: MemoryScope,
  ownerId: string,
  label: string,
): Effect.Effect<Map<string, Array<LiveChunk>>, SqlError> =>
  Effect.gen(function* () {
    const prefix = `${label}:`
    const rows = yield* sql`SELECT id, source, kind FROM memory_items
      WHERE scope = ${scope} AND owner_id = ${ownerId} AND superseded_by IS NULL AND tombstone = 0
        AND instr(source, ${prefix}) = 1`
    const decoded = yield* decodeLive(rows).pipe(Effect.orDie)
    const byPath = new Map<string, Array<LiveChunk>>()
    for (const row of decoded) {
      const tail = SOURCE_TAIL.exec(row.source.slice(prefix.length))
      const path = tail?.[1]
      const sha8 = tail?.[3]
      if (path === undefined || sha8 === undefined) {
        continue
      }
      const group = byPath.get(path) ?? []
      group.push({ id: row.id, sha8, kind: row.kind })
      byPath.set(path, group)
    }
    return byPath
  })

const invalid = (where: string, issue: string): Effect.Effect<never, SchemaViolation> =>
  Effect.fail(new SchemaViolation({ where: `reef.import.${where}`, issue }))

const validate = (options: ImportOptions): Effect.Effect<void, SchemaViolation> => {
  if (!isAbsolute(options.dir)) {
    return invalid("dir", "dir must be an absolute path")
  }
  if (!LABEL.test(options.source)) {
    return invalid("source", "source must match [A-Za-z0-9._-]+")
  }
  if (!(options.exclude ?? []).every((name) => LABEL.test(name))) {
    return invalid("exclude", "exclude names must match [A-Za-z0-9._-]+")
  }
  if (options.ownerId.trim() === "") {
    return invalid("ownerId", "ownerId must not be empty")
  }
  if (options.scope === "global" && options.ownerId !== "global") {
    return invalid("ownerId", 'scope "global" requires ownerId "global"')
  }
  if (options.kind !== "semantic" && options.kind !== "procedural") {
    return invalid("kind", "kind must be semantic or procedural")
  }
  return Effect.void
}

interface Tally {
  created: number
  superseded: number
  unchanged: number
  forgotten: number
  processed: number
}

const progress = (tally: Tally): Effect.Effect<void> => {
  tally.processed += 1
  return tally.processed % PROGRESS_EVERY === 0
    ? Effect.logInfo(`memory import: ${tally.processed} chunks processed`)
    : Effect.void
}

// Imports a markdown directory into the Reef. Idempotent per chunk: identity is the sha256 of the chunk content
// (sha8 in the source), so an unchanged file writes nothing; a changed chunk supersedes its predecessor; a chunk or
// file that disappeared is forgotten. Each write is its own transaction; a rerun after a failure converges.
export const importMarkdownDir = (
  options: ImportOptions,
): Effect.Effect<ImportReport, ImportError, Reef | SqlClient> =>
  Effect.gen(function* () {
    yield* validate(options)
    const reef = yield* Reef
    const sql = yield* SqlClient
    const root = yield* resolveRoot(options.dir)
    const listing = yield* listMarkdown(root, new Set(options.exclude ?? []))
    const skipped: Array<SkippedFile> = [...listing.skipped]

    const accepted = new Map<string, ReadonlyArray<Chunk>>()
    const rejected: Array<string> = []
    for (const path of listing.paths) {
      const outcome: Outcome = yield* Effect.promise(() => inspectFile(root, path))
      if (outcome.status === "text") {
        accepted.set(path, chunkMarkdownOf(outcome.text))
      } else if (outcome.status === "rejected") {
        rejected.push(path)
      } else {
        skipped.push({ path, reason: outcome.reason })
      }
    }

    const live = yield* liveChunksOf(sql, options.scope, options.ownerId, options.source)
    const tally: Tally = { created: 0, superseded: 0, unchanged: 0, forgotten: 0, processed: 0 }
    let chunkTotal = 0
    for (const [path, chunks] of accepted) {
      chunkTotal += chunks.length
      const unmatched = [...(live.get(path) ?? [])]
      live.delete(path)
      const pending: Array<{ readonly index: number; readonly chunk: Chunk }> = []
      for (const [index, chunk] of chunks.entries()) {
        const found = unmatched.findIndex((row) => row.sha8 === chunk.sha8 && row.kind === options.kind)
        if (found === -1) {
          pending.push({ index, chunk })
        } else {
          unmatched.splice(found, 1)
          tally.unchanged += 1
        }
        yield* progress(tally)
      }
      for (const { index, chunk } of pending) {
        const next = {
          kind: options.kind,
          content: chunk.content,
          source: `${options.source}:${path}#${index}:${chunk.sha8}`,
        }
        const stale = unmatched.shift()
        if (stale === undefined) {
          yield* reef.remember({ scope: options.scope, ownerId: options.ownerId, ...next })
          tally.created += 1
        } else {
          yield* reef.supersede(stale.id, next)
          tally.superseded += 1
        }
        yield* progress(tally)
      }
      for (const row of unmatched) {
        yield* reef.forget(row.id)
        tally.forgotten += 1
      }
    }
    // What remains belongs to files that are gone, or that are now skipped or rejected.
    for (const rows of live.values()) {
      for (const row of rows) {
        yield* reef.forget(row.id)
        tally.forgotten += 1
      }
    }

    return {
      files: accepted.size,
      chunks: chunkTotal,
      created: tally.created,
      superseded: tally.superseded,
      unchanged: tally.unchanged,
      forgotten: tally.forgotten,
      skipped,
      rejected,
    }
  })

const chunkMarkdownOf = (text: string): Array<Chunk> =>
  chunkMarkdown(text).map((content) => ({ content, sha8: sha8Of(content) }))
