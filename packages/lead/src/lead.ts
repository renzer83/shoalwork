import type {
  BotId,
  Budget,
  BudgetExceeded,
  NotFound,
  PolicyDenied,
  SchemaViolation,
  TaskId,
  TaskSpec,
  TaskState,
  Verdict,
} from "@shoalwork/contracts"
import { Context, type Effect, type Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { HandoffOutcome, HandoffTask } from "./handoff.js"
import type { IntakeInput } from "./intake.js"

export interface LeadShape {
  // The tier is optional: without one, tierFor(kind, routing) of the tier table decides.
  readonly intake: (spec: IntakeInput) => Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError>
  readonly get: (
    id: TaskId,
  ) => Effect.Effect<{ spec: TaskSpec; state: TaskState; verdict?: Verdict }, NotFound | SqlError>
  // Never fails: every error becomes a Verdict (blocked, failed, budget_exceeded or needs_approval).
  readonly runOnce: (id: TaskId) => Effect.Effect<Verdict, never>
  // Bot-to-Bot handoff (T-046): a child task for `to` whose parent is `taskLike.parentTaskId`, run by `from`.
  // Refused (not failed) past the parent's message limit; fails when `from` does not run the parent or the child's
  // budget is above what the parent has left.
  readonly handoff: (
    from: BotId,
    to: BotId,
    taskLike: HandoffTask,
    budget: Budget,
  ) => Effect.Effect<HandoffOutcome, NotFound | SchemaViolation | SqlError | PolicyDenied | BudgetExceeded>
  // Closes a task that will never get a verdict (idempotent for a task already settled); never fails.
  readonly abandon: (id: TaskId, reason: string) => Effect.Effect<void>
  readonly startWorker: (opts: {
    readonly concurrency: number
    readonly pollMs: number
  }) => Effect.Effect<void, never, Scope.Scope>
}

export class Lead extends Context.Service<Lead, LeadShape>()("@shoalwork/Lead") {}
