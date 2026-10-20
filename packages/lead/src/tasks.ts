import type { BeaconShape } from "@shoalwork/beacon"
import {
  type BotId,
  type NewEvent,
  NotFound,
  SessionId,
  TaskId,
  TaskSpec,
  type TaskState,
  TaskState as TaskStateSchema,
  Verdict,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export interface TaskRecord {
  readonly spec: TaskSpec
  readonly state: TaskState
  readonly verdict?: Verdict
  readonly attempts: number
  readonly sessionId?: SessionId
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TaskPatch {
  readonly state?: TaskState
  readonly verdict?: Verdict
  readonly sessionId?: SessionId
  readonly bumpAttempts?: boolean
}

export interface TaskStoreShape {
  readonly insert: (spec: TaskSpec) => Effect.Effect<void, SqlError>
  readonly get: (id: TaskId) => Effect.Effect<TaskRecord, NotFound | SqlError>
  // Applies the patch and returns the state the task had before it.
  readonly update: (id: TaskId, patch: TaskPatch) => Effect.Effect<TaskState, NotFound | SqlError>
  // Tasks of the bot that are running right now (the Bot is idle only when this is 0).
  readonly countRunning: (botId: BotId) => Effect.Effect<number, SqlError>
  // The most recent tasks of the bot, newest first (at most LIST_LIMIT).
  readonly listByBot: (botId: BotId) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>
}

// Enough for "continua a task <título>" to find the task the user means.
export const LIST_LIMIT = 200

export class TaskStore extends Context.Service<TaskStore, TaskStoreShape>()("@shoalwork/TaskStore") {}

const TaskRow = Schema.Struct({
  id: TaskId,
  bot_id: Schema.String,
  spec: Schema.String,
  state: TaskStateSchema,
  verdict: Schema.NullOr(Schema.String),
  attempts: Schema.Int,
  session_id: Schema.NullOr(SessionId),
  created_at: Schema.String,
  updated_at: Schema.String,
})
type TaskRow = typeof TaskRow.Type

const parseJson = (text: string): Effect.Effect<unknown> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => cause }).pipe(Effect.orDie)

// Rows are written by this module only: a mismatch is a bug, so it dies instead of becoming a typed error.
const decodeRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(TaskRow))(rows).pipe(Effect.orDie)

const toRecord = (row: TaskRow): Effect.Effect<TaskRecord> =>
  Effect.gen(function* () {
    const spec = yield* parseJson(row.spec).pipe(
      Effect.flatMap((raw) => Schema.decodeUnknownEffect(TaskSpec)(raw)),
      Effect.orDie,
    )
    const verdict =
      row.verdict === null
        ? undefined
        : yield* parseJson(row.verdict).pipe(
            Effect.flatMap((raw) => Schema.decodeUnknownEffect(Verdict)(raw)),
            Effect.orDie,
          )
    return {
      spec,
      state: row.state,
      ...(verdict === undefined ? {} : { verdict }),
      attempts: row.attempts,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })

export const makeTaskStore = (sql: SqlClient): TaskStoreShape => {
  const getRow = (id: TaskId) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM tasks WHERE id = ${id}`
      const [row] = yield* decodeRows(rows)
      if (row === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Task", id }))
      }
      return row
    })

  return {
    insert: (spec) =>
      Effect.gen(function* () {
        const now = nowIso()
        const encoded = yield* Schema.encodeEffect(TaskSpec)(spec).pipe(Effect.orDie)
        yield* sql`INSERT INTO tasks (id, bot_id, spec, state, attempts, created_at, updated_at)
          VALUES (${spec.id}, ${spec.botId}, ${JSON.stringify(encoded)}, 'received', 0, ${now}, ${now})`
      }),

    get: (id) => getRow(id).pipe(Effect.flatMap(toRecord)),

    countRunning: (botId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ${botId} AND state = 'running'`
        return rows[0]?.n ?? 0
      }),

    listByBot: (botId) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM tasks WHERE bot_id = ${botId}
          ORDER BY created_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`
        return yield* Effect.forEach(yield* decodeRows(rows), toRecord)
      }),

    update: (id, patch) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const verdictJson =
            patch.verdict === undefined
              ? row.verdict
              : JSON.stringify(yield* Schema.encodeEffect(Verdict)(patch.verdict).pipe(Effect.orDie))
          yield* sql`UPDATE tasks SET
            state = ${patch.state ?? row.state},
            verdict = ${verdictJson},
            session_id = ${patch.sessionId ?? row.session_id},
            attempts = ${patch.bumpAttempts === true ? row.attempts + 1 : row.attempts},
            updated_at = ${nowIso()}
            WHERE id = ${id}`
          return row.state
        }),
      ),
  }
}

export const TaskStoreLive: Layer.Layer<TaskStore, never, SqlClient> = Layer.effect(
  TaskStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return makeTaskStore(sql)
  }),
)

// Events are part of the task's own transitions, so a rejected or failed append is a bug or an outage, not an
// expected result: it becomes a defect and the runner turns it into a blocked verdict.
export const emit = (beacon: BeaconShape, event: NewEvent): Effect.Effect<void> =>
  beacon.append(event).pipe(Effect.orDie, Effect.asVoid)
