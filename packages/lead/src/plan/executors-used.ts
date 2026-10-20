import type { BeaconShape } from "@shoalwork/beacon"
import { EventPayloads, type ExecutorId, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"

const decodeStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])

// The executors that actually ran these tasks, from their executor.started events (the reviewer must not be one).
export const executorsUsed = (
  beacon: BeaconShape,
  taskIds: ReadonlyArray<TaskId>,
): Effect.Effect<ReadonlyArray<ExecutorId>, SqlError> =>
  Effect.gen(function* () {
    const found = new Set<ExecutorId>()
    for (const id of taskIds) {
      const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(id))))
      for (const event of events) {
        if (event.type !== "executor.started") continue
        const payload = decodeStarted(event.payload)
        if (Option.isSome(payload)) found.add(payload.value.executor)
      }
    }
    return Array.from(found)
  })

const decodeEvent = Schema.decodeUnknownOption(EventPayloads["executor.event"])

// The full text the executor ended a task with (its last `done` event). The verdict's summary is cut at SUMMARY_MAX.
export const fullResult = (
  beacon: BeaconShape,
  taskId: TaskId,
): Effect.Effect<string | undefined, SqlError> =>
  Effect.gen(function* () {
    const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(taskId))))
    for (const event of events.toReversed()) {
      if (event.type !== "executor.event") continue
      const payload = decodeEvent(event.payload)
      if (Option.isSome(payload) && payload.value.event.kind === "done") return payload.value.event.result
    }
    return undefined
  })
