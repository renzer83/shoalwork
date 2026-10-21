import { it } from "@effect/vitest"
import { BotId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { Drive, DriveError } from "../../src/drive/client.js"
import { callDriveTool, DRIVE_TOOLS, type DriveToolName } from "../../src/drive/connector.js"
import { type DriveSyncSummary, syncDrive } from "../../src/drive/sync.js"
import type { ToolGate } from "../../src/notion/tools.js"
import { fakeDrive, ROOT, recordingSink } from "./support.js"

const DOC = "application/vnd.google-apps.document"
const BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")

const rootWith = (docModified: string, mdModified: string) => ({
  files: [
    { id: "docRoot1", name: "Roadmap", mimeType: DOC, modifiedTime: docModified },
    { id: "mdRoot1", name: "nota.md", mimeType: "text/markdown", modifiedTime: mdModified, size: "40" },
    {
      id: "pdfRoot1",
      name: "contrato.pdf",
      mimeType: "application/pdf",
      modifiedTime: mdModified,
      size: "9",
    },
  ],
})

const MAY = "2026-10-01T10:00:00.000Z"
const JUNE = "2026-10-02T10:00:00.000Z"

// One sync pass against a fake Drive and a temp database. The database persists across passes of the same test
// only when the caller threads the same layer; each call here is its own pass.
const pass = (
  listings: ReturnType<typeof rootWith>,
  bodies: Record<string, string>,
  sink: Parameters<typeof syncDrive>[0]["sink"],
) => {
  const { shape, requests } = fakeDrive({ listings: { [ROOT]: [listings] }, bodies })
  return {
    requests,
    run: syncDrive({ rootFolderId: ROOT, sink }).pipe(Effect.provideService(Drive, shape)),
  }
}

describe("drive sync", () => {
  it.effect("imports each changed document once and never re-reads an unchanged one", () =>
    Effect.gen(function* () {
      const { sink, documents } = recordingSink()
      const bodies = { docRoot1: "Roadmap v1", mdRoot1: "# Nota" }
      const first = pass(rootWith(MAY, MAY), bodies, sink)
      const one: DriveSyncSummary = yield* first.run
      expect(one).toEqual({ listed: 3, imported: 2, unchanged: 0, skipped: 1 })
      expect(documents.map((document) => document.source)).toEqual(["drive:docRoot1", "drive:mdRoot1"])

      const second = pass(rootWith(MAY, MAY), bodies, sink)
      const two = yield* second.run
      expect(two).toEqual({ listed: 3, imported: 0, unchanged: 2, skipped: 1 })
      expect(documents).toHaveLength(2)
      expect(second.requests.every((url) => url.pathname.endsWith("/files"))).toBe(true)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a newer modifiedTime with the same text does not reimport", () =>
    Effect.gen(function* () {
      const { sink, documents } = recordingSink()
      const bodies = { docRoot1: "Roadmap v1", mdRoot1: "# Nota" }
      yield* pass(rootWith(MAY, MAY), bodies, sink).run
      const later = yield* pass(rootWith(JUNE, JUNE), bodies, sink).run
      expect(later.imported).toBe(0)
      expect(later.unchanged).toBe(2)
      expect(documents).toHaveLength(2)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a changed text is imported again under the same source label", () =>
    Effect.gen(function* () {
      const { sink, documents } = recordingSink()
      yield* pass(rootWith(MAY, MAY), { docRoot1: "Roadmap v1", mdRoot1: "# Nota" }, sink).run
      const edited = yield* pass(rootWith(JUNE, MAY), { docRoot1: "Roadmap v2", mdRoot1: "# Nota" }, sink).run
      expect(edited).toEqual({ listed: 3, imported: 1, unchanged: 1, skipped: 1 })
      expect(documents.at(-1)).toEqual({ source: "drive:docRoot1", name: "Roadmap", text: "Roadmap v2" })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("skips a document over 10 MB with a warning and imports nothing from it", () =>
    Effect.gen(function* () {
      const { sink, documents } = recordingSink()
      const listing = {
        files: [{ id: "docRoot1", name: "Roadmap", mimeType: DOC, modifiedTime: MAY }],
      }
      const huge = "x".repeat(10 * 1024 * 1024 + 1)
      const summary = yield* pass(listing, { docRoot1: huge }, sink).run
      expect(summary).toEqual({ listed: 1, imported: 0, unchanged: 0, skipped: 1 })
      expect(documents).toHaveLength(0)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a failed listing fails the sync and imports nothing", () =>
    Effect.gen(function* () {
      const { sink, documents } = recordingSink()
      const { shape } = fakeDrive({ listings: {}, bodies: {} })
      const error = yield* syncDrive({ rootFolderId: ROOT, sink }).pipe(
        Effect.provideService(Drive, shape),
        Effect.flip,
      )
      expect(error).toBeInstanceOf(DriveError)
      expect(documents).toHaveLength(0)
    }).pipe(Effect.provide(withTempDb())),
  )

  const allowGate: ToolGate = {
    evaluate: () => Effect.succeed({ effect: "allow", risk: "read" }),
  }
  const denyGate: ToolGate = {
    evaluate: () => Effect.succeed({ effect: "deny", risk: "read" }),
  }

  it.effect("drive.search finds synced documents by name and the gate decides whether it runs", () =>
    Effect.gen(function* () {
      const { sink } = recordingSink()
      yield* pass(rootWith(MAY, MAY), { docRoot1: "Roadmap v1", mdRoot1: "# Nota" }, sink).run
      const found = yield* callDriveTool(allowGate, BOT, "drive.search", { q: "road" })
      expect("results" in found && found.results.map((result) => result.id)).toEqual(["docRoot1"])

      const refused = yield* callDriveTool(denyGate, BOT, "drive.search", { q: "road" }).pipe(Effect.flip)
      expect(refused).toBeInstanceOf(DriveError)
      expect(refused.message).toBe("drive.search denied by policy")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("drive.file.get answers only for files already synced", () =>
    Effect.gen(function* () {
      const { sink } = recordingSink()
      yield* pass(rootWith(MAY, MAY), { docRoot1: "Roadmap v1", mdRoot1: "# Nota" }, sink).run
      const file = yield* callDriveTool(allowGate, BOT, "drive.file.get", { id: "docRoot1" })
      expect("id" in file && file.name).toBe("Roadmap")
      const missing = yield* callDriveTool(allowGate, BOT, "drive.file.get", { id: "neverSynced" }).pipe(
        Effect.flip,
      )
      expect(missing.message).toBe("file is not synced")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("the tools are read-only and their names are the contract names", () =>
    Effect.sync(() => {
      const names: ReadonlyArray<DriveToolName> = ["drive.search", "drive.file.get"]
      expect(DRIVE_TOOLS.map((tool) => tool.name).sort()).toEqual([...names].sort())
      expect(DRIVE_TOOLS.every((tool) => tool.risk === "read")).toBe(true)
    }),
  )
})
