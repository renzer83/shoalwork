import { Schema } from "effect"

// `Schema.brand` needs a literal identifier in v4, so each brand is written out.
const idPattern = (prefix: string) => Schema.isPattern(new RegExp(`^${prefix}_[0-9a-f-]{36}$`))

export const BotId = Schema.String.pipe(Schema.check(idPattern("bot")), Schema.brand("BotId"))
export type BotId = typeof BotId.Type
export const TaskId = Schema.String.pipe(Schema.check(idPattern("task")), Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type
export const PlanId = Schema.String.pipe(Schema.check(idPattern("plan")), Schema.brand("PlanId"))
export type PlanId = typeof PlanId.Type
export const StepId = Schema.String.pipe(Schema.check(idPattern("step")), Schema.brand("StepId"))
export type StepId = typeof StepId.Type
export const PodId = Schema.String.pipe(Schema.check(idPattern("pod")), Schema.brand("PodId"))
export type PodId = typeof PodId.Type
export const EventId = Schema.String.pipe(Schema.check(idPattern("evt")), Schema.brand("EventId"))
export type EventId = typeof EventId.Type
export const ApprovalId = Schema.String.pipe(Schema.check(idPattern("apr")), Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type
export const TideId = Schema.String.pipe(Schema.check(idPattern("tide")), Schema.brand("TideId"))
export type TideId = typeof TideId.Type

// External CLI session id: free format.
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type
// "claude-code", "claude-code@zai"
export const ExecutorId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9-]+(@[a-z0-9-]+)?$/)),
  Schema.brand("ExecutorId"),
)
export type ExecutorId = typeof ExecutorId.Type
export const ConnectorId = Schema.String.pipe(Schema.brand("ConnectorId"))
export type ConnectorId = typeof ConnectorId.Type
export const PolicyId = Schema.String.pipe(Schema.brand("PolicyId"))
export type PolicyId = typeof PolicyId.Type

export const makeId =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, prefix: string) =>
  (): S["Type"] =>
    Schema.decodeUnknownSync(schema)(`${prefix}_${crypto.randomUUID()}`)

export const newBotId = makeId(BotId, "bot")
export const newTaskId = makeId(TaskId, "task")
export const newPlanId = makeId(PlanId, "plan")
export const newStepId = makeId(StepId, "step")
export const newPodId = makeId(PodId, "pod")
export const newEventId = makeId(EventId, "evt")
export const newApprovalId = makeId(ApprovalId, "apr")
export const newTideId = makeId(TideId, "tide")
