import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { makeNotion, Notion, NotionError } from "../../src/notion/client.js"
import { NOTION_POLL_CRON, NOTION_POLL_JOB, notionPollTide, pollNotion } from "../../src/notion/poll.js"
import { fail, fakeTransport, fixture, ok, type Reply } from "./support.js"

const DATA_SOURCE = "ds_ideas"
const TestLayer = Layer.provideMerge(BeaconLive, withTempDb())

const iso = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 21, 10, 0, 0) + minute * 60_000).toISOString()

const pageAt = (id: string, minute: number): Record<string, unknown> => ({
  object: "page",
  id,
  url: `https://www.notion.so/${id}`,
  last_edited_time: iso(minute),
  properties: { Ideia: { id: "title", type: "title", title: [{ plain_text: `Ideia ${id}` }] } },
})

// Pages as the query answers them: given newest first, 50 per answer, the cursor is "p<offset>".
const pagedReply =
  (pages: ReadonlyArray<unknown>): Reply =>
  (request) => {
    const cursor = request.body?.start_cursor
    const offset = typeof cursor === "string" ? Number(cursor.slice(1)) : 0
    const next = offset + 50 < pages.length ? offset + 50 : null
    return Effect.succeed({
      object: "list",
      results: pages.slice(offset, offset + 50),
      has_more: next !== null,
      next_cursor: next === null ? null : `p${next}`,
    })
  }

// One poll with a fresh client (its rate limit starts empty). Runs under the TestClock: a poll of several pages waits
// between its requests.
const pollWith = (reply: Reply) => {
  const { transport, sent } = fakeTransport(reply)
  const run = pollNotion({ dataSourceId: DATA_SOURCE }).pipe(
    Effect.provideService(Notion, makeNotion(transport)),
  )
  return { run, sent }
}

const runWithClock = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(run)
    yield* TestClock.adjust("60 seconds")
    return yield* Fiber.join(fiber)
  })

const eventsOf = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly type: string
      readonly payload: string
    }>`SELECT type, payload FROM events
      WHERE type LIKE 'notion.%' ORDER BY position`
    return rows.map((row) => ({
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }))
  })

const Count = Schema.Array(Schema.Struct({ n: Schema.Number }))
const countSeen = (sql: SqlClient) =>
  sql`SELECT COUNT(*) AS n FROM notion_seen`.pipe(
    Effect.map((rows) => Schema.decodeUnknownSync(Count)(rows)[0]?.n ?? 0),
  )
const countSources = (sql: SqlClient) =>
  sql`SELECT COUNT(*) AS n FROM notion_sources`.pipe(
    Effect.map((rows) => Schema.decodeUnknownSync(Count)(rows)[0]?.n ?? 0),
  )

// Pages edited at minutes 1..count, newest first, with the given id prefix.
const editsDescending = (prefix: string, count: number): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_, i) => pageAt(`${prefix}-${count - i}`, count - i))

describe("notion poll", () => {
  it.effect("the first poll of a data source records its pages and emits no event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const pages = editsDescending("page", 10)
      const summary = yield* pollWith(pagedReply(pages)).run
      expect(summary).toEqual({ baselined: true, created: 0, updated: 0, unchanged: 0, skipped: 0 })
      expect(yield* eventsOf(sql)).toHaveLength(0)
      expect(yield* countSeen(sql)).toBe(10)
      expect(yield* countSources(sql)).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "the baseline follows next_cursor to the end: every page of 60 is recorded, none is an event",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        const { run, sent } = pollWith(pagedReply(editsDescending("page", 60)))
        const summary = yield* runWithClock(run)
        expect(summary).toMatchObject({ baselined: true, created: 0, skipped: 0 })
        expect(sent).toHaveLength(2)
        expect(sent[1]?.request.body).toMatchObject({ start_cursor: "p50" })
        expect(yield* countSeen(sql)).toBe(60)
        expect(yield* eventsOf(sql)).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a page added after the baseline is notion.page_created, and the pages before it are not", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* pollWith(pagedReply(editsDescending("page", 10))).run
      const added = [pageAt("page-new", 11), ...editsDescending("page", 10)]
      const summary = yield* pollWith(pagedReply(added)).run
      expect(summary).toMatchObject({ baselined: false, created: 1, updated: 0, unchanged: 1 })
      const events = yield* eventsOf(sql)
      expect(events.map((event) => event.type)).toEqual(["notion.page_created"])
      expect(events[0]?.payload).toEqual({
        dataSourceId: DATA_SOURCE,
        pageId: "page-new",
        lastEditedTime: iso(11),
        title: "Ideia page-new",
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a later poll emits notion.page_updated for the one edited page and nothing for the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* pollWith(pagedReply(editsDescending("page", 10))).run
      const others = Array.from({ length: 10 }, (_, i) => 10 - i)
        .filter((minute) => minute !== 3)
        .map((minute) => pageAt(`page-${minute}`, minute))
      const edited = [pageAt("page-3", 30), ...others]
      const summary = yield* pollWith(pagedReply(edited)).run
      expect(summary).toMatchObject({ baselined: false, created: 0, updated: 1, unchanged: 1 })
      const events = yield* eventsOf(sql)
      expect(events.map((event) => event.type)).toEqual(["notion.page_updated"])
      expect(events[0]?.payload).toEqual({
        dataSourceId: DATA_SOURCE,
        pageId: "page-3",
        lastEditedTime: iso(30),
        title: "Ideia page-3",
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reads 120 edits in one window across three requests and emits 120 notion.page_created", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* pollWith(pagedReply([pageAt("base", 0)])).run
      const { run, sent } = pollWith(pagedReply(editsDescending("edit", 120)))
      const summary = yield* runWithClock(run)
      expect(summary).toMatchObject({ baselined: false, created: 120, updated: 0 })
      expect(sent).toHaveLength(3)
      const events = yield* eventsOf(sql)
      expect(events).toHaveLength(120)
      expect(new Set(events.map((event) => event.type))).toEqual(new Set(["notion.page_created"]))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "reads past the old ten-page limit: 600 edits all become events, and the next poll finds nothing new",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* pollWith(pagedReply([pageAt("base", 0)])).run
        const edits = editsDescending("edit", 600)
        const first = pollWith(pagedReply(edits))
        const summary = yield* runWithClock(first.run)
        expect(summary).toMatchObject({ created: 600, updated: 0 })
        expect(first.sent).toHaveLength(12)
        expect(yield* eventsOf(sql)).toHaveLength(600)
        const second = pollWith(pagedReply(edits))
        const again = yield* runWithClock(second.run)
        expect(again).toMatchObject({ created: 0, updated: 0 })
        expect(second.sent).toHaveLength(1)
        expect(yield* eventsOf(sql)).toHaveLength(600)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("counts entries that are not readable pages as skipped, not as errors", () =>
    Effect.gen(function* () {
      const summary = yield* pollWith(ok(fixture("data-source-query.json"))).run
      expect(summary).toMatchObject({ baselined: true, skipped: 2 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("writes nothing and fails with a NotionError when the query is refused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const error = yield* Effect.flip(pollWith(fail(401)).run)
      expect(error).toBeInstanceOf(NotionError)
      expect(error.message).toBe("notion.poll failed with HTTP 401")
      expect(yield* eventsOf(sql)).toHaveLength(0)
      expect(yield* countSources(sql)).toBe(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("is registered as the five-minute system tide and runs the same poll", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const { transport, sent } = fakeTransport(ok(fixture("data-source-query.json")))
      const tide = notionPollTide(sql, beacon, makeNotion(transport), { dataSourceId: DATA_SOURCE })
      expect(tide.name).toBe(NOTION_POLL_JOB)
      expect(tide.expr).toBe(NOTION_POLL_CRON)
      expect(NOTION_POLL_CRON).toBe("*/5 * * * *")
      yield* tide.run
      expect(sent[0]?.request).toMatchObject({ method: "post", path: `data_sources/${DATA_SOURCE}/query` })
      expect(yield* countSources(sql)).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )
})
