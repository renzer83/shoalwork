import type { BeaconShape } from "@shoalwork/beacon"
import { type Event, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"

// Working memory is not stored: it is the tail of the task's event stream. Versions are contiguous from 1.
export const workingContext = (
  beacon: BeaconShape,
  taskId: TaskId,
  n: number,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Effect.gen(function* () {
    const count = Number.isFinite(n) ? Math.floor(n) : 0
    if (count <= 0) {
      return []
    }
    const streamId = streamIds.task(taskId)
    const last = yield* beacon.lastVersion(streamId)
    return yield* Stream.runCollect(beacon.readStream(streamId, Math.max(0, last - count)))
  })
