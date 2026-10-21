import { Context, Data, Effect, Redacted, Schema } from "effect"

// Drive v3 over fetch: T-088 adds no client library. Only drive.readonly is ever requested.
export const DRIVE_API = "https://www.googleapis.com/drive/v3"
// Drive refuses exports and downloads above 10 MB; such files are skipped with a warning, never truncated.
export const DRIVE_MAX_BYTES = 10 * 1024 * 1024
export const DRIVE_PAGE_SIZE = 200
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
export const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)"
// Ids go into a query and a path: only the characters Drive ids have.
const DriveId = /^[A-Za-z0-9_-]{1,128}$/

// A failed call. The message names the operation and the HTTP status only: never the body, never the token.
export class DriveError extends Data.TaggedError("DriveError")<{
  readonly op: string
  readonly message: string
}> {}

export interface DriveRequest {
  readonly op: string
  readonly url: URL
  readonly token: Redacted.Redacted<string>
}

export interface DriveResponse {
  readonly status: number
  readonly body: string
}

// The only way out to the network. fetchTransport is the production one; tests pass a fake.
export interface DriveTransport {
  readonly get: (request: DriveRequest) => Effect.Effect<DriveResponse, DriveError>
}

export const fetchTransport = (fetchFn: typeof fetch = fetch): DriveTransport => ({
  get: (request) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchFn(request.url, {
          headers: { Authorization: `Bearer ${Redacted.value(request.token)}` },
        })
        return { status: response.status, body: await response.text() }
      },
      catch: () => new DriveError({ op: request.op, message: `${request.op} failed` }),
    }),
})

export interface DriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedTime: string
  readonly md5Checksum: string | undefined
  readonly size: number | undefined
}

// What a file read gives: its text, or the reason it was not read.
export type DocumentRead =
  | { readonly status: "text"; readonly text: string }
  | { readonly status: "skipped"; readonly reason: "too_large" | "unsupported" }

export interface DriveShape {
  // Every file under the folder, descending into subfolders. Folders and shortcuts are not returned.
  readonly listFiles: (folderId: string) => Effect.Effect<ReadonlyArray<DriveFile>, DriveError>
  readonly readText: (file: DriveFile) => Effect.Effect<DocumentRead, DriveError>
}

export class Drive extends Context.Service<Drive, DriveShape>()("@shoalwork/Drive") {}

// Wire shapes as Drive answers them. Only the fields this connector reads are named; size arrives as a string.
const FileWire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  modifiedTime: Schema.String,
  md5Checksum: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.String),
})
const ListWire = Schema.Struct({
  nextPageToken: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(FileWire)),
})

const decodeAnswer = <A, I>(
  op: string,
  schema: Schema.Codec<A, I>,
  body: string,
): Effect.Effect<A, DriveError> =>
  Effect.try({
    try: (): unknown => JSON.parse(body),
    catch: () => new DriveError({ op, message: `${op} answer is not JSON` }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(() => new DriveError({ op, message: `${op} answer does not match its schema` })),
      ),
    ),
  )

const answered = (op: string, response: DriveResponse): Effect.Effect<string, DriveError> => {
  if (response.status >= 200 && response.status < 300) return Effect.succeed(response.body)
  const message = response.status === 429 ? `${op} rate limited` : `${op} failed with HTTP ${response.status}`
  return Effect.fail(new DriveError({ op, message }))
}

const toDriveFile = (wire: typeof FileWire.Type): DriveFile => {
  const size = wire.size === undefined ? undefined : Number(wire.size)
  return {
    id: wire.id,
    name: wire.name,
    mimeType: wire.mimeType,
    modifiedTime: wire.modifiedTime,
    md5Checksum: wire.md5Checksum,
    size: size === undefined || !Number.isFinite(size) ? undefined : size,
  }
}

const filesUrl = (folderId: string, pageToken: string | undefined): URL => {
  const url = new URL(`${DRIVE_API}/files`)
  url.searchParams.set("q", `'${folderId}' in parents and trashed=false`)
  url.searchParams.set("fields", LIST_FIELDS)
  url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE))
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken)
  return url
}

const exportUrl = (fileId: string, mimeType: string): URL => {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export`)
  url.searchParams.set("mimeType", mimeType)
  return url
}

const mediaUrl = (fileId: string): URL => {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set("alt", "media")
  return url
}

// Google Docs export as plain text, Sheets as CSV, .md and .txt downloaded as they are. Anything else is not read.
const readUrlOf = (file: DriveFile): URL | undefined => {
  if (file.mimeType === GOOGLE_DOC_MIME) return exportUrl(file.id, "text/plain")
  if (file.mimeType === GOOGLE_SHEET_MIME) return exportUrl(file.id, "text/csv")
  if (/\.(md|txt)$/i.test(file.name)) return mediaUrl(file.id)
  return undefined
}

export const makeDrive = (
  transport: DriveTransport,
  accessToken: Effect.Effect<Redacted.Redacted<string>, DriveError>,
): DriveShape => {
  const get = (op: string, url: URL): Effect.Effect<string, DriveError> =>
    Effect.gen(function* () {
      const token = yield* accessToken
      const response = yield* transport.get({ op, url, token })
      return yield* answered(op, response)
    })

  const listPage = (
    folderId: string,
    pageToken: string | undefined,
  ): Effect.Effect<
    { readonly files: ReadonlyArray<DriveFile>; readonly next: string | undefined },
    DriveError
  > =>
    get("drive.list", filesUrl(folderId, pageToken)).pipe(
      Effect.flatMap((body) => decodeAnswer("drive.list", ListWire, body)),
      Effect.map((list) => ({
        files: (list.files ?? []).map(toDriveFile),
        next: list.nextPageToken,
      })),
    )

  // Follows nextPageToken to its end: a listing cut short would hide files, not just delay them.
  const listChildren = (folderId: string): Effect.Effect<ReadonlyArray<DriveFile>, DriveError> => {
    const page = (
      pageToken: string | undefined,
      acc: ReadonlyArray<DriveFile>,
    ): Effect.Effect<ReadonlyArray<DriveFile>, DriveError> =>
      listPage(folderId, pageToken).pipe(
        Effect.flatMap(({ files, next }) =>
          next === undefined ? Effect.succeed([...acc, ...files]) : page(next, [...acc, ...files]),
        ),
      )
    return page(undefined, [])
  }

  const listFiles = (folderId: string): Effect.Effect<ReadonlyArray<DriveFile>, DriveError> =>
    Effect.gen(function* () {
      if (!DriveId.test(folderId)) {
        return yield* Effect.fail(
          new DriveError({ op: "drive.list", message: "folder id does not match Drive ids" }),
        )
      }
      const seen = new Set<string>([folderId])
      const out: Array<DriveFile> = []
      const visit = (id: string): Effect.Effect<void, DriveError> =>
        Effect.gen(function* () {
          const children = yield* listChildren(id)
          for (const child of children) {
            if (child.mimeType === DRIVE_FOLDER_MIME) {
              if (!seen.has(child.id)) {
                seen.add(child.id)
                yield* visit(child.id)
              }
            } else if (child.mimeType !== DRIVE_SHORTCUT_MIME) {
              out.push(child)
            }
          }
        })
      yield* visit(folderId)
      return out
    })

  const readText = (file: DriveFile): Effect.Effect<DocumentRead, DriveError> => {
    const url = readUrlOf(file)
    if (url === undefined) return Effect.succeed({ status: "skipped", reason: "unsupported" })
    if (file.size !== undefined && file.size > DRIVE_MAX_BYTES) {
      return Effect.succeed({ status: "skipped", reason: "too_large" })
    }
    return get("drive.read", url).pipe(
      Effect.map(
        (text): DocumentRead =>
          new TextEncoder().encode(text).byteLength > DRIVE_MAX_BYTES
            ? { status: "skipped", reason: "too_large" }
            : { status: "text", text },
      ),
    )
  }

  return { listFiles, readText }
}
