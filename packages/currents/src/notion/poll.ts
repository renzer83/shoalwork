import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type Conflict, type SchemaViolation, streamIds } from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { Notion, type NotionError, type NotionShape } from "./client.js"
import { decodeWire, PageWire, QueryWire, titleOf } from "./wire.js"

// Poll of one data source (T-087). It reads the pages edited since the watermark, newest first, and diffs them against
// notion_seen. The first poll of a data source only records its pages (baseline, no event). Later, a new page is
// notion.page_created and a page with a newer edit is notion.page_updated; each event and its notion_seen row commit
// together, and the watermark moves last.
export const NOTION_POLL_JOB = "notion-poll"
export const NOTION_POLL_CRON = "*/5 * * * *"
export const NOTION_POLL_PAGE_SIZE = 50
const NOTION_ACTOR = "system:notion"
const EPOCH = "1970-01-01T00:00:00.000Z"

export interface NotionPollOptions {
  readonly dataSourceId: string
}

export interface NotionPollSummary {
  // True when this poll was the first of the data source: its pages were recorded and no event was emitted.
  readonly baselined: boolean
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  // Entries of the answer that are not pages this poll can read (e.g. a partial page). They are not errors.
  readonly skipped: number
}

export type PollError = NotionError | SqlError | Conflict | SchemaViolation

type Outcome = "created" | "updated" | "unchanged"

const SourceRows = Schema.Array(Schema.Struct({ watermark: Schema.String }))
const SeenRows = Schema.Array(Schema.Struct({ last_edited_time: Schema.String }))

const readWatermark = (sql: SqlClient, dataSourceId: string): Effect.Effect<string | undefined, SqlError> =>
  sql`SELECT watermark FROM notion_sources WHERE data_source_id = ${dataSourceId}`.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(SourceRows)(rows).pipe(Effect.orDie)),
    Effect.map((rows) => rows[0]?.watermark),
  )

interface Walk {
  readonly pages: ReadonlyArray<PageWire>
  readonly skipped: number
}

// Walks the data source newest edit first and follows next_cursor to its end. It stops early only at the first page
// older than the watermark: an earlier poll read everything older. There is no page cap: a walk that stopped before the
// end would move the watermark past edits it never read, and those edits would be lost.
const walkEdits = (
  dataSourceId: string,
  watermark: string | undefined,
): Effect.Effect<Walk, NotionError, Notion> => {
  const step = (
    cursor: string | undefined,
    acc: ReadonlyArray<PageWire>,
    skipped: number,
  ): Effect.Effect<Walk, NotionError, Notion> =>
    Effect.gen(function* () {
      const notion = yield* Notion
      const answer = yield* notion.request({
        op: "notion.poll",
        method: "post",
        path: `data_sources/${encodeURIComponent(dataSourceId)}/query`,
        body: {
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          page_size: NOTION_POLL_PAGE_SIZE,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
      })
      const query = yield* decodeWire("notion.poll", QueryWire, answer)
      // Each entry is decoded alone: one unreadable entry must not hide the others.
      const decoded = yield* Effect.forEach(query.results, (raw) =>
        Schema.decodeUnknownEffect(PageWire)(raw).pipe(Effect.option),
      )
      const pages = decoded.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
      const fresh =
        watermark === undefined ? pages : pages.filter((page) => page.last_edited_time >= watermark)
      const all = [...acc, ...fresh]
      const skippedNow = skipped + decoded.length - pages.length
      const passedWatermark =
        watermark !== undefined && pages.some((page) => page.last_edited_time < watermark)
      const next = query.next_cursor
      if (!query.has_more || next === null || passedWatermark) {
        return { pages: all, skipped: skippedNow }
      }
      return yield* step(next, all, skippedNow)
    })
  return step(undefined, [], 0)
}

const upsertSeen = (sql: SqlClient, dataSourceId: string, page: PageWire): Effect.Effect<void, SqlError> =>
  sql`INSERT INTO notion_seen (data_source_id, page_id, last_edited_time)
    VALUES (${dataSourceId}, ${page.id}, ${page.last_edited_time})
    ON CONFLICT(data_source_id, page_id) DO UPDATE SET last_edited_time = excluded.last_edited_time`.pipe(
    Effect.asVoid,
  )

const seenEdit = (
  sql: SqlClient,
  dataSourceId: string,
  pageId: string,
): Effect.Effect<string | undefined, SqlError> =>
  sql`SELECT last_edited_time FROM notion_seen WHERE data_source_id = ${dataSourceId} AND page_id = ${pageId}`.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(SeenRows)(rows).pipe(Effect.orDie)),
    Effect.map((rows) => rows[0]?.last_edited_time),
  )

const recordPage = (
  sql: SqlClient,
  beacon: BeaconShape,
  dataSourceId: string,
  page: PageWire,
): Effect.Effect<Outcome, PollError> =>
  Effect.gen(function* () {
    const previous = yield* seenEdit(sql, dataSourceId, page.id)
    if (previous === page.last_edited_time) return "unchanged" as const
    const type = previous === undefined ? ("notion.page_created" as const) : ("notion.page_updated" as const)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* upsertSeen(sql, dataSourceId, page)
        yield* beacon.append({
          streamId: streamIds.system,
          type,
          payload: {
            dataSourceId,
            pageId: page.id,
            lastEditedTime: page.last_edited_time,
            title: titleOf(page),
          },
          actor: NOTION_ACTOR,
          correlationId: `notion:${page.id}:${page.last_edited_time}`,
        })
      }),
    )
    return previous === undefined ? ("created" as const) : ("updated" as const)
  })

const newestOf = (pages: ReadonlyArray<PageWire>): string | undefined =>
  pages.reduce<string | undefined>(
    (newest, page) =>
      newest === undefined || page.last_edited_time > newest ? page.last_edited_time : newest,
    undefined,
  )

// Records the pages of a data source for the first time: no event, and the watermark is their newest edit.
const baseline = (
  sql: SqlClient,
  dataSourceId: string,
  pages: ReadonlyArray<PageWire>,
): Effect.Effect<void, SqlError> =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.forEach(pages, (page) => upsertSeen(sql, dataSourceId, page), { discard: true })
      yield* sql`INSERT INTO notion_sources (data_source_id, watermark) VALUES (${dataSourceId}, ${newestOf(pages) ?? EPOCH})`
    }),
  )

const advance = (sql: SqlClient, dataSourceId: string, watermark: string): Effect.Effect<void, SqlError> =>
  sql`INSERT INTO notion_sources (data_source_id, watermark) VALUES (${dataSourceId}, ${watermark})
    ON CONFLICT(data_source_id) DO UPDATE SET watermark = excluded.watermark`.pipe(Effect.asVoid)

export const pollNotion = (
  options: NotionPollOptions,
): Effect.Effect<NotionPollSummary, PollError, Notion | Beacon | SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const dataSourceId = options.dataSourceId
    const watermark = yield* readWatermark(sql, dataSourceId)
    const walk = yield* walkEdits(dataSourceId, watermark)
    if (watermark === undefined) {
      yield* baseline(sql, dataSourceId, walk.pages)
      return { baselined: true, created: 0, updated: 0, unchanged: 0, skipped: walk.skipped }
    }
    // Oldest edit first, so the events of one poll come in the order the edits happened.
    const outcomes = yield* Effect.forEach([...walk.pages].reverse(), (page) =>
      recordPage(sql, beacon, dataSourceId, page),
    )
    const newest = newestOf(walk.pages)
    if (newest !== undefined && newest > watermark) yield* advance(sql, dataSourceId, newest)
    const count = (outcome: Outcome): number => outcomes.filter((seen) => seen === outcome).length
    return {
      baselined: false,
      created: count("created"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      skipped: walk.skipped,
    }
  })

// The poll as a system tide: the composition root calls startSystemTide(sql, notionPollTide(...)). Typed structurally,
// so currents does not depend on tides (tides sits above lead, which sits above currents).
export interface NotionPollTide {
  readonly name: string
  readonly expr: string
  readonly run: Effect.Effect<void, PollError>
}

export const notionPollTide = (
  sql: SqlClient,
  beacon: BeaconShape,
  notion: NotionShape,
  options: NotionPollOptions,
): NotionPollTide => ({
  name: NOTION_POLL_JOB,
  expr: NOTION_POLL_CRON,
  run: pollNotion(options).pipe(
    Effect.asVoid,
    Effect.provideService(Notion, notion),
    Effect.provideService(Beacon, beacon),
    Effect.provideService(SqlClient, sql),
  ),
})
