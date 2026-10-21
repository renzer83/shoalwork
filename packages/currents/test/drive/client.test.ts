import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import { DRIVE_MAX_BYTES, DriveError, type DriveFile, makeDrive } from "../../src/drive/client.js"
import { fakeDrive, fixture, ROOT, SUB } from "./support.js"

const listings = {
  [ROOT]: [fixture("list-root.json")],
  [SUB]: [fixture("list-sub.json")],
}

const bodies = {
  docRoot1: "Roadmap do trimestre",
  sheetRoot1: "meta,valor\nx,1",
  mdRoot1: "# Nota\n\ntexto",
  txtSub1: "ideia solta",
}

const pathOf = (url: URL): string => url.pathname.split("/").slice(-2).join("/")

describe("drive client", () => {
  it.effect("lists the root folder recursively and returns files only, not folders or shortcuts", () =>
    Effect.gen(function* () {
      const { shape, requests } = fakeDrive({ listings, bodies })
      const files = yield* shape.listFiles(ROOT)
      expect(files.map((file) => file.name)).toEqual([
        "Roadmap",
        "Metas",
        "nota.md",
        "contrato.pdf",
        "ideias.txt",
      ])
      expect(requests[0]?.searchParams.get("q")).toBe(`'${ROOT}' in parents and trashed=false`)
      expect(requests[0]?.searchParams.get("pageSize")).toBe("200")
      expect(requests.map(pathOf)).toEqual(["v3/files", "v3/files"])
    }),
  )

  it.effect("follows nextPageToken to the last page", () =>
    Effect.gen(function* () {
      const first = {
        files: [
          { id: "a1", name: "a.md", mimeType: "text/markdown", modifiedTime: "2026-10-01T00:00:00.000Z" },
        ],
      }
      const second = {
        files: [
          { id: "b1", name: "b.md", mimeType: "text/markdown", modifiedTime: "2026-10-01T00:00:00.000Z" },
        ],
      }
      const { shape, requests } = fakeDrive({ listings: { [ROOT]: [first, second] }, bodies: {} })
      const files = yield* shape.listFiles(ROOT)
      expect(files.map((file) => file.id)).toEqual(["a1", "b1"])
      expect(requests[1]?.searchParams.get("pageToken")).toBe("1")
    }),
  )

  it.effect("reads Docs, Sheets and .md, and skips other types without any request", () =>
    Effect.gen(function* () {
      const { shape, requests } = fakeDrive({ listings, bodies })
      const files = yield* shape.listFiles(ROOT)
      const find = (id: string) => files.find((file) => file.id === id)
      const doc = find("docRoot1")
      const sheet = find("sheetRoot1")
      const markdown = find("mdRoot1")
      const pdf = find("pdfRoot1")
      if (doc === undefined || sheet === undefined || markdown === undefined || pdf === undefined) {
        throw new Error("fixture listing changed")
      }
      expect(yield* shape.readText(doc)).toEqual({ status: "text", text: bodies.docRoot1 })
      expect(yield* shape.readText(sheet)).toEqual({ status: "text", text: bodies.sheetRoot1 })
      expect(yield* shape.readText(markdown)).toEqual({ status: "text", text: bodies.mdRoot1 })
      const before = requests.length
      expect(yield* shape.readText(pdf)).toEqual({ status: "skipped", reason: "unsupported" })
      expect(requests.length).toBe(before)
    }),
  )

  it.effect("requests the export mime type per Google type", () =>
    Effect.gen(function* () {
      const { shape, requests } = fakeDrive({ listings, bodies })
      const files = yield* shape.listFiles(ROOT)
      const doc = files.find((file) => file.id === "docRoot1")
      const sheet = files.find((file) => file.id === "sheetRoot1")
      const markdown = files.find((file) => file.id === "mdRoot1")
      if (doc === undefined || sheet === undefined || markdown === undefined)
        throw new Error("fixture changed")
      yield* shape.readText(doc)
      yield* shape.readText(sheet)
      yield* shape.readText(markdown)
      const read = requests.slice(2)
      expect(read.map(pathOf)).toEqual(["docRoot1/export", "sheetRoot1/export", "files/mdRoot1"])
      expect(read[0]?.searchParams.get("mimeType")).toBe("text/plain")
      expect(read[1]?.searchParams.get("mimeType")).toBe("text/csv")
      expect(read[2]?.searchParams.get("alt")).toBe("media")
    }),
  )

  it.effect("skips a file whose metadata says it is over 10 MB, without requesting it", () =>
    Effect.gen(function* () {
      const big: DriveFile = {
        id: "big1",
        name: "big.md",
        mimeType: "text/markdown",
        modifiedTime: "2026-10-01T00:00:00.000Z",
        md5Checksum: undefined,
        size: DRIVE_MAX_BYTES + 1,
      }
      const { shape, requests } = fakeDrive({ listings, bodies })
      expect(yield* shape.readText(big)).toEqual({ status: "skipped", reason: "too_large" })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("skips an export whose body is over 10 MB instead of truncating it", () =>
    Effect.gen(function* () {
      const huge = "x".repeat(DRIVE_MAX_BYTES + 1)
      const { shape } = fakeDrive({ listings, bodies: { ...bodies, docRoot1: huge } })
      const doc: DriveFile = {
        id: "docRoot1",
        name: "Roadmap",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-01T10:00:00.000Z",
        md5Checksum: undefined,
        size: undefined,
      }
      expect(yield* shape.readText(doc)).toEqual({ status: "skipped", reason: "too_large" })
    }),
  )

  it.effect("rejects a folder id that is not a Drive id, before any request", () =>
    Effect.gen(function* () {
      const { shape, requests } = fakeDrive({ listings, bodies })
      const error = yield* shape.listFiles("root' or name='x").pipe(Effect.flip)
      expect(error).toBeInstanceOf(DriveError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("answers a 429 as a rate limit and never includes the body or the token", () =>
    Effect.gen(function* () {
      const { shape } = fakeDrive({ listings, bodies, status: 429 })
      const error = yield* shape.listFiles(ROOT).pipe(Effect.flip)
      expect(error.message).toBe("drive.list rate limited")
      expect(error.message).not.toContain("fake-access-token")
    }),
  )

  it.effect("a transport failure surfaces as a DriveError", () => {
    const shape = makeDrive(
      {
        get: (request) => Effect.fail(new DriveError({ op: request.op, message: `${request.op} failed` })),
      },
      Effect.succeed(Redacted.make("fake-access-token")),
    )
    return Effect.gen(function* () {
      const error = yield* shape.listFiles(ROOT).pipe(Effect.flip)
      expect(error.message).toBe("drive.list failed")
    })
  })
})
