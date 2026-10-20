import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type NotFound, newTaskId, SchemaViolation, streamIds, TaskSpec } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { emit, type TaskStoreShape } from "./tasks.js"

export const TASKS_QUEUE = "tasks"

export interface IntakeDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly bots: BotRegistryShape
  readonly tasks: TaskStoreShape
}

// Stores the task, records task.received and queues the job in ONE transaction: a task is never half-accepted.
export const makeIntake =
  (deps: IntakeDeps) =>
  (input: Omit<TaskSpec, "id">): Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const spec = yield* Schema.decodeUnknownEffect(TaskSpec)({ ...input, id: newTaskId() }).pipe(
        Effect.mapError((e) => new SchemaViolation({ where: "TaskSpec", issue: e.issue })),
      )
      yield* deps.bots.get(spec.botId)
      yield* deps.sql.withTransaction(
        Effect.gen(function* () {
          yield* deps.tasks.insert(spec)
          yield* emit(deps.beacon, {
            streamId: streamIds.task(spec.id),
            type: "task.received",
            payload: { task: spec },
            actor: "system:lead",
            correlationId: spec.id,
          })
          yield* Jobs.enqueue(TASKS_QUEUE, { taskId: spec.id }).pipe(
            Effect.provideService(SqlClient, deps.sql),
          )
        }),
      )
      return spec
    })
