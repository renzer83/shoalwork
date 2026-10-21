import { createHash } from "node:crypto"
import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  type MarkdownImporter,
  type MemoryImportError,
  type ObsidianError,
  syncObsidian,
} from "../obsidian/sync.js"
import { Drive, type DriveError, type DriveFile, type DriveShape } from "./client.js"

export const KNOWLEDGE_SYNC_JOB = "knowledge-sync"
// Every 6 hours, for both sources (T-088).
export const KNOWLEDGE_SYNC_CRON = "0 */6 * * *"

// Where the text of a Drive document goes: the Reef, through the composition root. The source label is "drive:<fileId>",
// so a repeat import of the same document supersedes its memory and never duplicates it.
export interface DocumentSink {
  readonly importDocument: (document: {
    readonly source: string
    readonly name: string
    readonly text: string
  }) => Effect.Effect<void, MemoryImportError>
}

export interface DriveSyncOptions {
  readonly rootFolderId: string
  readonly sink: DocumentSink
}

export interface DriveSyncSummary {
  readonly listed: number
  readonly imported: number
  readonly unchanged: number
  readonly skipped: number
}

export type DriveSyncError = DriveError | MemoryImportError | SqlError

const KnownRows = Schema.Array(Schema.Struct({ modified_time: Schema.String, sha256: Schema.String }))
interface Known {
  readonly modified_time: string
  readonly sha256: string
}

const knownFile = (sql: SqlClient, fileId: string): Effect.Effect<Known | undefined, SqlError> =>
  sql`SELECT modified_time, sha256 FROM drive_files WHERE file_id = ${fileId}`.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(KnownRows)(rows).pipe(Effect.orDie)),
    Effect.map((rows) => rows[0]),
  )

const recordFile = (
  sql: SqlClient,
  file: DriveFile,
  sha256: string,
  importedAt: string,
): Effect.Effect<void, SqlError> =>
  sql`INSERT INTO drive_files (file_id, name, mime, modified_time, sha256, imported_at)
    VALUES (${file.id}, ${file.name}, ${file.mimeType}, ${file.modifiedTime}, ${sha256}, ${importedAt})
    ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, mime = excluded.mime,
      modified_time = excluded.modified_time, sha256 = excluded.sha256, imported_at = excluded.imported_at`.pipe(
    Effect.asVoid,
  )

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex")

type Outcome = "imported" | "unchanged" | "skipped"

// A file the sync has already seen at this modifiedTime is not read again. A file whose text is unchanged after an edit
// (same sha256) updates its row and imports nothing. The memory is written before the row: a failure in between makes the
// next run import the same source again, which the sink treats as a supersede.
const syncFile = (
  sql: SqlClient,
  sink: DocumentSink,
  drive: DriveShape,
  file: DriveFile,
): Effect.Effect<Outcome, DriveSyncError> =>
  Effect.gen(function* () {
    const known = yield* knownFile(sql, file.id)
    if (known !== undefined && known.modified_time === file.modifiedTime) return "unchanged" as const
    const read = yield* drive.readText(file)
    if (read.status === "skipped") {
      if (read.reason === "too_large") {
        yield* Effect.logWarning(`drive: file ${file.id} skipped, larger than 10 MB`)
      } else {
        yield* Effect.logInfo(`drive: file ${file.id} skipped, type not read`)
      }
      return "skipped" as const
    }
    const sha256 = sha256Of(read.text)
    const same = known !== undefined && known.sha256 === sha256
    if (!same) {
      yield* sink.importDocument({ source: `drive:${file.id}`, name: file.name, text: read.text })
    }
    const now = yield* Clock.currentTimeMillis
    yield* recordFile(sql, file, sha256, new Date(now).toISOString())
    return same ? ("unchanged" as const) : ("imported" as const)
  })

// One pass over the root folder, recursively. Files are handled one at a time: a failure stops the pass and the next
// run starts over from the rows already written.
export const syncDrive = (
  options: DriveSyncOptions,
): Effect.Effect<DriveSyncSummary, DriveSyncError, Drive | SqlClient> =>
  Effect.gen(function* () {
    const drive = yield* Drive
    const sql = yield* SqlClient
    const files = yield* drive.listFiles(options.rootFolderId)
    const tally: Record<Outcome, number> = { imported: 0, unchanged: 0, skipped: 0 }
    for (const file of files) {
      tally[yield* syncFile(sql, options.sink, drive, file)] += 1
    }
    return { listed: files.length, ...tally }
  })

// The knowledge sync as a system tide: the composition root calls startSystemTide(sql, knowledgeSyncTide(...)). Typed
// structurally, so currents does not depend on tides.
export type KnowledgeSyncError = DriveSyncError | ObsidianError

export interface KnowledgeSources {
  // Absent when the source is not configured: its half of the tide does nothing.
  readonly drive?: DriveSyncOptions | undefined
  readonly obsidian?: { readonly vaultPath: string; readonly importer: MarkdownImporter } | undefined
}

export interface KnowledgeSyncTide {
  readonly name: string
  readonly expr: string
  readonly run: Effect.Effect<void, KnowledgeSyncError>
}

// Drive first, then Obsidian. A failure in one source does not skip the other: both run, then the first failure fails
// the tide, so the scheduler records it.
const runKnowledgeSync = (
  sources: KnowledgeSources,
): Effect.Effect<void, KnowledgeSyncError, Drive | SqlClient> =>
  Effect.gen(function* () {
    const failures: Array<KnowledgeSyncError> = []
    if (sources.drive !== undefined) {
      const options = sources.drive
      yield* syncDrive(options).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error)
          }),
        ),
      )
    }
    if (sources.obsidian !== undefined) {
      const options = sources.obsidian
      yield* syncObsidian(options).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error)
          }),
        ),
      )
    }
    const [first] = failures
    if (first !== undefined) return yield* Effect.fail(first)
  })

export const knowledgeSyncTide = (
  sql: SqlClient,
  drive: DriveShape,
  sources: KnowledgeSources,
): KnowledgeSyncTide => ({
  name: KNOWLEDGE_SYNC_JOB,
  expr: KNOWLEDGE_SYNC_CRON,
  run: runKnowledgeSync(sources).pipe(
    Effect.provideService(Drive, drive),
    Effect.provideService(SqlClient, sql),
  ),
})
