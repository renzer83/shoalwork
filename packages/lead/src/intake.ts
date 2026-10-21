import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  exceeds,
  type ModelTier,
  NotFound,
  newTaskId,
  SchemaViolation,
  streamIds,
  TaskSpec,
  usageToBudget,
  type Verdict,
} from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import type { TierRouting } from "@shoalwork/executors"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { botUsageInWindow } from "./budget.js"
import { makeLifecycle } from "./lifecycle.js"
import { makeOutcomes } from "./outcomes.js"
import { authorizeResume } from "./resume.js"
import { tierFor } from "./routing.js"
import { emit, type TaskStoreShape } from "./tasks.js"
import { describeFailure } from "./verdict.js"

export const TASKS_QUEUE = "tasks"

const NO_COST = { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 }

// The task is stored and closed as failed (reason budget) in one transaction; no job is queued and no executor runs.
const refuse = (deps: IntakeDeps, spec: TaskSpec, limit: TaskSpec["budget"], used: TaskSpec["budget"]) => {
  const lifecycle = makeLifecycle({ beacon: deps.beacon, tasks: deps.tasks, bots: deps.bots })
  const outcomes = makeOutcomes(deps.beacon)
  const verdict: Verdict = {
    kind: "budget_exceeded",
    summary: "bot budget exceeded",
    evidence: ["budget scope: bot"],
    cost: NO_COST,
  }
  const recordOutcomes = outcomes.recordTaskOutcomes(
    spec.correlationId === undefined ? [spec.id] : [spec.correlationId, spec.id],
    "failed",
  )
  return deps.sql
    .withTransaction(
      Effect.gen(function* () {
        yield* deps.tasks.insert(spec)
        yield* emit(deps.beacon, {
          streamId: streamIds.task(spec.id),
          type: "task.received",
          payload: { task: spec },
          actor: "system:lead",
          correlationId: spec.id,
        })
        yield* lifecycle.transition(spec, "failed", { verdict }, "budget")
        yield* emit(deps.beacon, {
          streamId: streamIds.task(spec.id),
          type: "budget.exceeded",
          payload: { scope: "bot", refId: spec.botId, limit, used },
          actor: "system:lead",
          correlationId: spec.id,
        })
      }),
    )
    .pipe(
      // Derived data (outcomes.ts): a failure to write it is reported, never a failed intake.
      Effect.andThen(
        recordOutcomes.pipe(
          Effect.catch((error) => {
            const failure = describeFailure(error)
            return lifecycle.raiseError(spec, "lead.outcomes", failure.tag, failure.message)
          }),
        ),
      ),
    )
}

export interface IntakeDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly bots: BotRegistryShape
  readonly tasks: TaskStoreShape
  // Task kind -> tier table of config/model-tiers.yaml: decides the tier of a task that does not carry one.
  readonly routing: TierRouting
  readonly botBudgetWindowMs: number
}

// A task may name its tier; without one the routing table decides from its kind.
export type IntakeInput = Omit<TaskSpec, "id" | "tier"> & { readonly tier?: ModelTier }

// Stores the task, records task.received and queues the job in ONE transaction: a task is never half-accepted.
// A Bot already over its budget window gets the task recorded as failed (reason budget) and nothing queued.
export const makeIntake =
  (deps: IntakeDeps) =>
  (input: IntakeInput): Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const tier = input.tier ?? tierFor(input.kind, deps.routing)
      const spec = yield* Schema.decodeUnknownEffect(TaskSpec)({ ...input, tier, id: newTaskId() }).pipe(
        Effect.mapError((e) => new SchemaViolation({ where: "TaskSpec", issue: e.issue })),
      )
      // A continuation is refused before anything is stored; the same check runs again inside the transaction below.
      yield* authorizeResume(deps.tasks, spec)
      const bot = yield* deps.bots.get(spec.botId)
      // An archived Bot takes no new work: it is refused like a Bot the registry does not know.
      const archived = (yield* deps.bots.list()).some(
        (entry) => entry.id === spec.botId && entry.state === "archived",
      )
      if (archived) {
        return yield* Effect.fail(new NotFound({ entity: "Bot", id: spec.botId }))
      }
      const used = yield* botUsageInWindow(deps.beacon, spec.botId, deps.botBudgetWindowMs)
      if (exceeds(usageToBudget(used), bot.budget).exceeded) {
        yield* refuse(deps, spec, bot.budget, usageToBudget(used))
        return spec
      }
      yield* deps.sql.withTransaction(
        Effect.gen(function* () {
          yield* authorizeResume(deps.tasks, spec)
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
