import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { DriveError } from "../../src/drive/client.js"
import { type KnowledgeSources, knowledgeSyncTide } from "../../src/drive/sync.js"
import {
  type MarkdownImporter,
  type MarkdownImportReport,
  type MarkdownImportRequest,
  OBSIDIAN_EXCLUDED_DIRS,
  OBSIDIAN_SOURCE,
  ObsidianError,
  syncObsidian,
} from "../../src/obsidian/sync.js"
import { fakeDrive, ROOT, recordingSink } from "../drive/support.js"

// A fake of the Reef importer: it records each call and reports what a first import would report.
const recordingImporter = (
  report: MarkdownImportReport = { created: 3, superseded: 0, unchanged: 0, forgotten: 0 },
) => {
  const calls: Array<MarkdownImportRequest> = []
  const importer: MarkdownImporter = {
    importDir: (request) =>
      Effect.sync(() => {
        calls.push(request)
        return report
      }),
  }
  return { importer, calls }
}

describe("obsidian sync", () => {
  it.effect("imports the vault with the obsidian label and the templates directory excluded", () =>
    Effect.gen(function* () {
      const { importer, calls } = recordingImporter()
      const report = yield* syncObsidian({ vaultPath: "/Users/me/Vault", importer })
      expect(report).toEqual({ created: 3, superseded: 0, unchanged: 0, forgotten: 0 })
      expect(calls).toEqual([
        { dir: "/Users/me/Vault", source: OBSIDIAN_SOURCE, exclude: OBSIDIAN_EXCLUDED_DIRS },
      ])
      expect(OBSIDIAN_EXCLUDED_DIRS).toContain("templates")
    }),
  )

  it.effect("refuses a relative vault path before any import", () =>
    Effect.gen(function* () {
      const { importer, calls } = recordingImporter()
      const error = yield* syncObsidian({ vaultPath: "Vault", importer }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ObsidianError)
      expect(calls).toHaveLength(0)
    }),
  )

  it.effect(
    "a second pass over an unchanged vault reports nothing created (the importer owns the dedup)",
    () =>
      Effect.gen(function* () {
        const { importer } = recordingImporter({ created: 0, superseded: 0, unchanged: 3, forgotten: 0 })
        const again = yield* syncObsidian({ vaultPath: "/Users/me/Vault", importer })
        expect(again.created).toBe(0)
        expect(again.unchanged).toBe(3)
      }),
  )

  it.effect("the knowledge tide runs Obsidian even when Drive fails, then fails with the Drive error", () =>
    Effect.gen(function* () {
      const { importer, calls } = recordingImporter()
      const { shape } = fakeDrive({ listings: {}, bodies: {} })
      const { sink } = recordingSink()
      const sources: KnowledgeSources = {
        drive: { rootFolderId: ROOT, sink },
        obsidian: { vaultPath: "/Users/me/Vault", importer },
      }
      const sql = yield* SqlClient
      const tide = knowledgeSyncTide(sql, shape, sources)
      expect(tide.name).toBe("knowledge-sync")
      expect(tide.expr).toBe("0 */6 * * *")
      const error = yield* tide.run.pipe(Effect.flip)
      expect(error).toBeInstanceOf(DriveError)
      expect(calls).toHaveLength(1)
    }).pipe(Effect.provide(withTempDb())),
  )
})
