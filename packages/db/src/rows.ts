import { EventId } from "@shoalwork/contracts"
import { Schema } from "effect"

// Row shapes mirror the SQL columns (snake_case). Decoded at the db boundary.
export const EventRow = Schema.Struct({
  position: Schema.Int,
  id: EventId,
  stream_id: Schema.String,
  version: Schema.Int,
  type: Schema.String,
  payload: Schema.String,
  actor: Schema.String,
  correlation_id: Schema.String,
  causation_id: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
})
export type EventRow = typeof EventRow.Type

export const JobState = Schema.Literals(["queued", "active", "done", "failed"])
export type JobState = typeof JobState.Type

export const JobRow = Schema.Struct({
  id: Schema.Int,
  queue: Schema.String,
  payload: Schema.String,
  state: JobState,
  attempts: Schema.Int,
  max_attempts: Schema.Int,
  run_at: Schema.String,
  locked_at: Schema.NullOr(Schema.String),
  heartbeat_at: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
})
export type JobRow = typeof JobRow.Type
