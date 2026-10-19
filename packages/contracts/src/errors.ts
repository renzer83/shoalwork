import { Data } from "effect"
import type { Budget } from "./budget.js"

export class SchemaViolation extends Data.TaggedError("SchemaViolation")<{
  where: string
  issue: unknown
}> {}

export class NotFound extends Data.TaggedError("NotFound")<{
  entity: string
  id: string
}> {}

export class Conflict extends Data.TaggedError("Conflict")<{
  streamId: string
  expectedVersion: number
}> {}

export class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  scope: "task" | "bot" | "pod"
  limit: Budget
  used: Budget
}> {}

export class PolicyDenied extends Data.TaggedError("PolicyDenied")<{
  botId: string
  tool: string
  resource?: string
}> {}

export class ApprovalTimeout extends Data.TaggedError("ApprovalTimeout")<{
  approvalId: string
}> {}

export class ExecutorSpawnError extends Data.TaggedError("ExecutorSpawnError")<{
  executor: string
  cause: unknown
}> {}

export class ExecutorProtocolError extends Data.TaggedError("ExecutorProtocolError")<{
  executor: string
  line: string
  cause: unknown
}> {}

export class TankError extends Data.TaggedError("TankError")<{
  op: string
  cause: unknown
}> {}

export class WorktreeConflict extends Data.TaggedError("WorktreeConflict")<{
  branch: string
  path: string
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  key: string
  message: string
}> {}

export type ContractError =
  | SchemaViolation
  | NotFound
  | Conflict
  | BudgetExceeded
  | PolicyDenied
  | ApprovalTimeout
  | ExecutorSpawnError
  | ExecutorProtocolError
  | TankError
  | WorktreeConflict
  | ConfigError
