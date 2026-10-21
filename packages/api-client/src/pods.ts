import { TaskState } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { ApiClient } from "./client.js"

// The Pod routes of the core (T-116): GET /pods and GET /pods/:id. The actions are the existing routes:
// POST /tasks/:id/stop and POST /control/pause.

export const PodState = Schema.Literals(["open", "closed"])
export type PodState = typeof PodState.Type

export const PodBase = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  name: Schema.String,
  state: PodState,
  threadId: Schema.Number,
  botIds: Schema.Array(Schema.String),
  createdAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
})
export type PodBase = typeof PodBase.Type

export const PodSummary = Schema.Struct({
  ...PodBase.fields,
  stepsDone: Schema.Number,
  stepsTotal: Schema.Number,
  costUsd: Schema.Number,
})
export type PodSummary = typeof PodSummary.Type

export const PodList = Schema.Struct({ pods: Schema.Array(PodSummary) })

// "pending": the step has no task yet (a dependency is still running or has not started).
export const StepState = Schema.Union([Schema.Literal("pending"), TaskState])
export type StepState = typeof StepState.Type

export const PodUsage = Schema.Struct({
  usd: Schema.Number,
  tokensIn: Schema.Number,
  tokensOut: Schema.Number,
})
export type PodUsage = typeof PodUsage.Type

export const PodStep = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  state: StepState,
  botId: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  usage: PodUsage,
})
export type PodStep = typeof PodStep.Type

export const PodMessage = Schema.Struct({
  position: Schema.Number,
  occurredAt: Schema.String,
  taskId: Schema.String,
  stepId: Schema.NullOr(Schema.String),
  botId: Schema.String,
  kind: Schema.Literals(["handoff", "result", "status"]),
  text: Schema.String,
})
export type PodMessage = typeof PodMessage.Type

export const PodDetail = Schema.Struct({
  pod: PodBase,
  plan: Schema.NullOr(Schema.Struct({ id: Schema.String, taskId: Schema.String, state: Schema.String })),
  steps: Schema.Array(PodStep),
  messages: Schema.Array(PodMessage),
})
export type PodDetail = typeof PodDetail.Type

// The answers of the action routes are read for their shape only; the screen does not use their fields.
export const StopAck = Schema.Struct({ stopped: Schema.Unknown })
export const ControlAck = Schema.Struct({ ok: Schema.Boolean })

export const listPods = (client: ApiClient, state?: PodState) =>
  client.get(state === undefined ? "/pods" : `/pods?state=${state}`, PodList)

export const getPod = (client: ApiClient, id: string) =>
  client.get(`/pods/${encodeURIComponent(id)}`, PodDetail)

// Stops the Pod's plan task (and what runs under it), as POST /tasks/:id/stop does for any task.
export const stopPod = (client: ApiClient, taskId: string) =>
  client.post(`/tasks/${encodeURIComponent(taskId)}/stop`, {}, StopAck)

// Pauses one Bot by id or name; the Pod's auxiliary Bots are paused one by one.
export const pauseBot = (client: ApiClient, bot: string) => client.post("/control/pause", { bot }, ControlAck)
