import { readFileSync } from "node:fs"
import { Effect, Redacted } from "effect"
import {
  type DriveRequest,
  type DriveResponse,
  type DriveTransport,
  makeDrive,
} from "../../src/drive/client.js"
import type { DocumentSink } from "../../src/drive/sync.js"

// Listings are read from test/fixtures (no network). Each folder maps to its pages in order: the next page is asked
// with pageToken "<index>". Exports and media downloads are keyed by file id.
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/drive/${name}`, import.meta.url), "utf8"))

export interface DriveFixtures {
  readonly listings: Readonly<Record<string, ReadonlyArray<unknown>>>
  readonly bodies: Readonly<Record<string, string>>
  // When set, every request answers this status (e.g. 429).
  readonly status?: number | undefined
}

const answer = (url: URL, fixtures: DriveFixtures): DriveResponse => {
  if (fixtures.status !== undefined) return { status: fixtures.status, body: "{}" }
  const parts = url.pathname.split("/")
  const last = parts[parts.length - 1]
  if (last === "files") {
    const folder = /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")?.[1]
    const pages = folder === undefined ? undefined : fixtures.listings[folder]
    const index = Number(url.searchParams.get("pageToken") ?? "0")
    const page = pages?.[index]
    if (pages === undefined || page === undefined) return { status: 404, body: "{}" }
    const next = index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}
    return { status: 200, body: JSON.stringify({ ...(page as object), ...next }) }
  }
  const fileId = last === "export" ? (parts[parts.length - 2] ?? "") : (last ?? "")
  const body = fixtures.bodies[fileId]
  return body === undefined ? { status: 404, body: "{}" } : { status: 200, body }
}

// A transport that answers from the fixtures and records every URL it was asked for. No network.
export const fakeDrive = (fixtures: DriveFixtures) => {
  const requests: Array<URL> = []
  const transport: DriveTransport = {
    get: (request: DriveRequest) =>
      Effect.sync(() => {
        requests.push(request.url)
        return answer(request.url, fixtures)
      }),
  }
  const shape = makeDrive(transport, Effect.succeed(Redacted.make("fake-access-token")))
  return { shape, requests }
}

// A sink that records every document it is given.
export const recordingSink = () => {
  const documents: Array<{ readonly source: string; readonly name: string; readonly text: string }> = []
  const sink: DocumentSink = {
    importDocument: (document) =>
      Effect.sync(() => {
        documents.push(document)
      }),
  }
  return { sink, documents }
}

export const ROOT = "rootFolder1"
export const SUB = "subFolder1"
