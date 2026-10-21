import { GitSha, ReplayOverrides, type TaskId, TaskId as TaskIdSchema } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Data, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// The `replays` and `context_snapshots` tables (migration 0032). Only the Lead writes them.
export interface ReplayLink {
  readonly id: string
  readonly sourceTaskId: TaskId
  readonly newTaskId: TaskId
  readonly overrides: ReplayOverrides
  readonly baseSha: string | undefined
  // The executor a model override applies to; the model is ignored on any other executor.
  readonly modelExecutor: string | undefined
  readonly contextFrozen: boolean
  readonly createdAt: string
}

// A replay row exists but cannot be read or applied. A run that meets it stops: it never runs as an ordinary task with
// the overrides lost, and never delivers (T-122).
export class ReplayUnavailable extends Data.TaggedError("ReplayUnavailable")<{ readonly reason: string }> {}

const Row = Schema.Struct({
  id: Schema.String,
  source_task_id: Schema.String,
  new_task_id: Schema.String,
  overrides: Schema.String,
  base_sha: Schema.NullOr(Schema.String),
  model_executor: Schema.NullOr(Schema.String),
  context_frozen: Schema.Int,
  created_at: Schema.String,
})

const decodeRow = Schema.decodeUnknownOption(Row)
const decodeOverrides = Schema.decodeUnknownOption(ReplayOverrides)
const decodeSha = Schema.decodeUnknownOption(GitSha)
const decodeTaskId = Schema.decodeUnknownOption(TaskIdSchema)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Undefined when the row does not decode (the caller decides what that means).
const toLink = (raw: unknown): ReplayLink | undefined => {
  const row = Option.getOrUndefined(decodeRow(raw))
  if (row === undefined) return undefined
  const overrides = Option.getOrUndefined(decodeOverrides(parse(row.overrides)))
  const sourceTaskId = Option.getOrUndefined(decodeTaskId(row.source_task_id))
  const newTaskId = Option.getOrUndefined(decodeTaskId(row.new_task_id))
  // A stored base that is not a hash is a broken row, not "no base".
  const baseSha = row.base_sha === null ? Option.some(undefined) : Option.map(decodeSha(row.base_sha), String)
  if (
    overrides === undefined ||
    sourceTaskId === undefined ||
    newTaskId === undefined ||
    Option.isNone(baseSha)
  ) {
    return undefined
  }
  return {
    id: row.id,
    sourceTaskId,
    newTaskId,
    overrides,
    baseSha: baseSha.value,
    modelExecutor: row.model_executor ?? undefined,
    contextFrozen: row.context_frozen === 1,
    createdAt: row.created_at,
  }
}

// The replay that created this task, if any. A row that exists and does not decode is ReplayUnavailable, not "none".
export const replayOfTask = (
  sql: SqlClient,
  newTaskId: TaskId,
): Effect.Effect<ReplayLink | undefined, SqlError | ReplayUnavailable> =>
  Effect.gen(function* () {
    const [row] = yield* sql`SELECT * FROM replays WHERE new_task_id = ${newTaskId}`
    if (row === undefined) return undefined
    const link = toLink(row)
    return link ?? (yield* Effect.fail(new ReplayUnavailable({ reason: "replay row unreadable" })))
  })

// For reading a comparison: a row that does not decode is reported as missing.
export const replayById = (sql: SqlClient, id: string): Effect.Effect<ReplayLink | undefined, SqlError> =>
  sql`SELECT * FROM replays WHERE id = ${id}`.pipe(Effect.map(([row]) => toLink(row)))

// The replay behind a running task. No SqlClient in scope (a bare test core) or no row means "not a replay"; a read that
// fails, or a row that does not decode, FAILS the run (fail closed): nothing that follows may treat it as ordinary.
export const replayOfRun = (taskId: TaskId): Effect.Effect<ReplayLink | undefined, ReplayUnavailable> =>
  Effect.gen(function* () {
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient))
    if (sql === undefined) return undefined
    return yield* replayOfTask(sql, taskId).pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(new ReplayUnavailable({ reason: "replay row not readable" })),
      ),
    )
  })

export const insertReplay = (
  sql: SqlClient,
  link: Omit<ReplayLink, "createdAt">,
): Effect.Effect<void, SqlError> =>
  sql`INSERT INTO replays (id, source_task_id, new_task_id, overrides, base_sha, model_executor, context_frozen, created_at)
    VALUES (${link.id}, ${link.sourceTaskId}, ${link.newTaskId}, ${JSON.stringify(link.overrides)},
      ${link.baseSha ?? null}, ${link.modelExecutor ?? null}, ${link.contextFrozen ? 1 : 0}, ${nowIso()})`.pipe(
    Effect.asVoid,
  )

export interface ContextSnapshot {
  readonly text: string
  readonly level: string
  readonly used: number
  readonly budget: number
}

const SnapshotRow = Schema.Struct({
  text: Schema.String,
  level: Schema.String,
  used: Schema.Int,
  budget: Schema.Int,
})
const decodeSnapshot = Schema.decodeUnknownOption(SnapshotRow)

export const saveSnapshot = (
  sql: SqlClient,
  taskId: TaskId,
  snapshot: ContextSnapshot,
): Effect.Effect<void, SqlError> =>
  sql`INSERT OR IGNORE INTO context_snapshots (task_id, text, level, used, budget, created_at)
    VALUES (${taskId}, ${snapshot.text}, ${snapshot.level}, ${snapshot.used}, ${snapshot.budget}, ${nowIso()})`.pipe(
    Effect.asVoid,
  )

export const loadSnapshot = (
  sql: SqlClient,
  taskId: TaskId,
): Effect.Effect<ContextSnapshot | undefined, SqlError> =>
  sql`SELECT text, level, used, budget FROM context_snapshots WHERE task_id = ${taskId}`.pipe(
    Effect.map(([row]) => Option.getOrUndefined(decodeSnapshot(row))),
  )
