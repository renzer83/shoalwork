import { BotId, PodId, TaskId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"

export interface PodRecord {
  readonly id: PodId
  readonly taskId: TaskId
  readonly botIds: ReadonlyArray<BotId>
  readonly threadId: number
  readonly state: "open" | "closed"
}

export const PodRow = Schema.Struct({
  id: PodId,
  task_id: TaskId,
  bot_ids: Schema.String,
  thread_id: Schema.Int,
  state: Schema.Literals(["open", "closed"]),
  created_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
})
type PodRow = typeof PodRow.Type
const PodRows = Schema.Array(PodRow)
const BotIds = Schema.Array(BotId)

// Rows are written by this module only: a mismatch is a bug, so it dies instead of becoming a typed error.
export const decodePodRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(PodRows)(rows).pipe(Effect.orDie)

export const toRecord = (row: PodRow): Effect.Effect<PodRecord> =>
  Effect.try({ try: (): unknown => JSON.parse(row.bot_ids), catch: (cause) => cause }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(BotIds)(raw)),
    Effect.map((botIds) => ({
      id: row.id,
      taskId: row.task_id,
      botIds,
      threadId: row.thread_id,
      state: row.state,
    })),
    Effect.orDie,
  )
