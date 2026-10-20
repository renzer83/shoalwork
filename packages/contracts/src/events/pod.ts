import { Schema } from "effect"
import { BotId, PodId, TaskId } from "../ids.js"

// A Pod opened for an approved plan (T-049); written in the same transaction as its pods row.
export const PodOpenedPayload = Schema.Struct({
  podId: PodId,
  taskId: TaskId,
  threadId: Schema.Int,
  botIds: Schema.Array(BotId),
})

// The Pod closed after its auxiliary steps finished; the summary is the one remembered in memory (pod scope).
export const PodClosedPayload = Schema.Struct({
  podId: PodId,
  taskId: TaskId,
  summary: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
})
