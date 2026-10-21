import { type BotId, EventId, EventPayloads, streamIds, type TimelinePage } from "@shoalwork/contracts"
import { DateTime, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// What GET /messages reads from the Beacon (T-113): the events of one Bot's conversation, projected into the items
// the apps draw. The events table is queried directly: the filter is by payload, and pages go backwards from a cursor.

export const TEXT_MAX = 8_000
const LINE_MAX = 200
const INPUT_MAX = 400

type Encoded = (typeof TimelinePage.Encoded)["items"][number]

const Row = Schema.Struct({
  position: Schema.Int,
  id: EventId,
  type: Schema.String,
  payload: Schema.String,
  occurred_at: Schema.String,
})
type Row = typeof Row.Type

const ApprovalRow = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  resolved_by: Schema.NullOr(Schema.String),
})

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// A stored payload that is not JSON is skipped, never an error for the reader.
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

const decodeInbound = Schema.decodeUnknownOption(EventPayloads["message.inbound"])
const decodeOutbound = Schema.decodeUnknownOption(EventPayloads["message.outbound"])
const decodeExecutorEvent = Schema.decodeUnknownOption(EventPayloads["executor.event"])
const decodeFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])
const decodeState = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const decodeRequested = Schema.decodeUnknownOption(EventPayloads["approval.requested"])

const toStatus = (raw: string | undefined): "pending" | "approved" | "denied" | "expired" =>
  raw === "pending" || raw === "approved" || raw === "denied" ? raw : "expired"

// Items of one event row; most rows give one, a finished run gives one per artifact. Statuses of approvals come from
// the table, so the row passes through with the status looked up by the caller.
export const itemsOf = (
  row: Row,
  approvals: ReadonlyMap<string, { readonly status: string; readonly resolvedBy: string | null }>,
): ReadonlyArray<Encoded> => {
  const payload = parseJson(row.payload)
  const base = { position: row.position, occurredAt: row.occurred_at }
  switch (row.type) {
    case "message.inbound": {
      const decoded = decodeInbound(payload)
      return Option.isNone(decoded)
        ? []
        : [
            {
              kind: "message",
              ...base,
              eventId: row.id,
              direction: "in",
              channel: decoded.value.channel,
              text: clip(decoded.value.text, TEXT_MAX),
            },
          ]
    }
    case "message.outbound": {
      const decoded = decodeOutbound(payload)
      return Option.isNone(decoded)
        ? []
        : [
            {
              kind: "message",
              ...base,
              eventId: row.id,
              direction: "out",
              channel: decoded.value.channel,
              text: clip(decoded.value.text, TEXT_MAX),
            },
          ]
    }
    case "task.state_changed": {
      const decoded = decodeState(payload)
      return Option.isNone(decoded)
        ? []
        : [
            {
              kind: "event",
              ...base,
              name: "task_state",
              taskId: decoded.value.taskId,
              state: decoded.value.to,
              text: clip(decoded.value.reason ?? `${decoded.value.from} -> ${decoded.value.to}`, LINE_MAX),
            },
          ]
    }
    case "executor.finished": {
      const decoded = decodeFinished(payload)
      return Option.isNone(decoded)
        ? []
        : [
            {
              kind: "event",
              ...base,
              name: "finished",
              taskId: decoded.value.taskId,
              verdict: decoded.value.verdict.kind,
              text: clip(decoded.value.verdict.summary, LINE_MAX),
            },
          ]
    }
    case "executor.event": {
      const decoded = decodeExecutorEvent(payload)
      if (Option.isNone(decoded)) {
        return []
      }
      const { taskId, event } = decoded.value
      if (event.kind === "command") {
        return [
          {
            kind: "event",
            ...base,
            name: "command",
            taskId,
            text: clip(event.cmd, LINE_MAX),
            ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          },
        ]
      }
      if (event.kind === "file_edit") {
        return [{ kind: "event", ...base, name: "file_edit", taskId, text: clip(event.path, LINE_MAX) }]
      }
      if (event.kind === "done") {
        return event.artifacts.map(
          (artifact): Encoded => ({
            kind: "artifact",
            ...base,
            taskId,
            artifactKind: artifact.kind,
            ref: clip(artifact.ref, TEXT_MAX),
            ...(artifact.summary === undefined ? {} : { summary: clip(artifact.summary, LINE_MAX) }),
          }),
        )
      }
      return []
    }
    case "approval.requested": {
      const decoded = decodeRequested(payload)
      if (Option.isNone(decoded)) {
        return []
      }
      const { action } = decoded.value
      const current = approvals.get(decoded.value.approvalId)
      const input = action.input === undefined ? undefined : JSON.stringify(action.input)
      return [
        {
          kind: "approval",
          ...base,
          approvalId: decoded.value.approvalId,
          taskId: decoded.value.taskId,
          botId: decoded.value.botId,
          tool: clip(action.tool, LINE_MAX),
          ...(action.resource === undefined ? {} : { resource: clip(action.resource, LINE_MAX) }),
          ...(input === undefined ? {} : { input: clip(input, INPUT_MAX) }),
          risk: decoded.value.risk,
          expiresAt: DateTime.formatIso(decoded.value.expiresAt),
          // An approval the table no longer knows cannot be decided any more.
          status: toStatus(current?.status),
          ...(current?.resolvedBy ? { resolvedBy: current.resolvedBy } : {}),
        },
      ]
    }
    default:
      return []
  }
}

export type Cursor =
  | { readonly mode: "before"; readonly before: number }
  | { readonly mode: "after"; readonly after: number }

const COLUMNS = "e.position, e.id, e.type, e.payload, e.occurred_at"

// Only the Bot's own stream (messages) and the streams of its tasks are read, each through the (stream_id, version)
// index; the rest of the log is never scanned. Every task event of a run (state, executor, approval) lives in
// `task:<id>`, and `tasks.bot_id` says whose task it is. `where` bounds the position and `order` sorts the union.
export const timelineQuery = (
  sql: SqlClient,
  botId: BotId,
  where: "e.position < " | "e.position > ",
  position: number,
  order: "DESC" | "ASC",
  limit: number,
) =>
  sql`SELECT ${sql.literal(COLUMNS)} FROM events e
      WHERE e.stream_id = ${streamIds.bot(botId)} AND e.type IN ('message.inbound', 'message.outbound')
        AND ${sql.literal(where)} ${position}
      UNION ALL
      SELECT ${sql.literal(COLUMNS)} FROM tasks t JOIN events e ON e.stream_id = 'task:' || t.id
      WHERE t.bot_id = ${botId}
        AND (e.type IN ('task.state_changed', 'executor.finished', 'approval.requested')
          OR (e.type = 'executor.event'
            AND json_extract(e.payload, '$.event.kind') IN ('command', 'file_edit', 'done')))
        AND ${sql.literal(where)} ${position}
      ORDER BY position ${sql.literal(order)} LIMIT ${limit}`

const selectRows = (sql: SqlClient, botId: BotId, cursor: Cursor, limit: number) =>
  cursor.mode === "before"
    ? timelineQuery(sql, botId, "e.position < ", cursor.before, "DESC", limit)
    : timelineQuery(sql, botId, "e.position > ", cursor.after, "ASC", limit)

const approvalStatuses = (sql: SqlClient, rows: ReadonlyArray<Row>) =>
  Effect.gen(function* () {
    const ids = rows.flatMap((row) => {
      const requested =
        row.type === "approval.requested" ? decodeRequested(parseJson(row.payload)) : Option.none()
      return Option.isSome(requested) ? [requested.value.approvalId] : []
    })
    if (ids.length === 0) {
      return new Map<string, { readonly status: string; readonly resolvedBy: string | null }>()
    }
    const found = yield* sql`SELECT id, status, resolved_by FROM approvals WHERE id IN ${sql.in(ids)}`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ApprovalRow))(found).pipe(Effect.orDie)
    return new Map(decoded.map((row) => [row.id, { status: row.status, resolvedBy: row.resolved_by }]))
  })

// `limit` events of the Bot's conversation: the newest before `cursor.before` (shown oldest first), or everything
// after `cursor.after`. A page is exact in events, so a finished run with artifacts can make it a few items longer.
export const readTimeline = (
  botId: BotId,
  cursor: Cursor,
  limit: number,
): Effect.Effect<typeof TimelinePage.Encoded, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    // Head first: an event that lands between the two reads is replayed by the live feed, never missed.
    const headRows = yield* sql`SELECT COALESCE(MAX(position), 0) AS head FROM events`
    const head = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ head: Schema.Int })))(
      headRows,
    ).pipe(Effect.orDie)
    const raw = yield* selectRows(sql, botId, cursor, cursor.mode === "before" ? limit + 1 : limit)
    const all = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(raw).pipe(Effect.orDie)
    const more = cursor.mode === "before" && all.length > limit
    const rows = [...(more ? all.slice(0, limit) : all)].sort((a, b) => a.position - b.position)
    const statuses = yield* approvalStatuses(sql, rows)
    const items = rows.flatMap((row) => itemsOf(row, statuses))
    const oldest = rows[0]
    return {
      botId,
      items,
      nextBefore: more && oldest !== undefined ? oldest.position : null,
      head: head[0]?.head ?? 0,
    }
  })
