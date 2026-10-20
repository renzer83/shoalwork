import { Schema } from "effect"
import { TaskState } from "../enums.js"
import { PlanId, TaskId } from "../ids.js"
import { TaskSpec } from "../task.js"

export const TaskReceivedPayload = Schema.Struct({ task: TaskSpec })

export const TaskPlannedPayload = Schema.Struct({
  taskId: TaskId,
  planId: PlanId,
  stepCount: Schema.Int,
})

export const TaskStateChangedPayload = Schema.Struct({
  taskId: TaskId,
  from: TaskState,
  to: TaskState,
  reason: Schema.optional(Schema.String),
})
