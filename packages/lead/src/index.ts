import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { NotFound, SchemaViolation, TaskId, TaskSpec, TaskState, Verdict } from "@shoalwork/contracts"
import { ExecutorRegistry, type TierConfig } from "@shoalwork/executors"
import { Tank } from "@shoalwork/tank"
import { Context, Effect, Layer, type Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { makeIntake } from "./intake.js"
import { DEFAULT_LEAD_CONFIG, type LeadConfig, makeRunner } from "./runner.js"
import { TaskStore, TaskStoreLive } from "./tasks.js"
import { makeWorker } from "./worker.js"

export interface LeadShape {
  readonly intake: (
    spec: Omit<TaskSpec, "id">,
  ) => Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError>
  readonly get: (
    id: TaskId,
  ) => Effect.Effect<{ spec: TaskSpec; state: TaskState; verdict?: Verdict }, NotFound | SqlError>
  // Never fails: every error becomes a Verdict (blocked, failed, budget_exceeded or needs_approval).
  readonly runOnce: (id: TaskId) => Effect.Effect<Verdict, never>
  readonly startWorker: (opts: {
    readonly concurrency: number
    readonly pollMs: number
  }) => Effect.Effect<void, never, Scope.Scope>
}

export class Lead extends Context.Service<Lead, LeadShape>()("@shoalwork/Lead") {}

// `tiers` is config/model-tiers.yaml (validated by the composition root): it decides the executor of every task.
export const LeadLive = (
  tiers: TierConfig,
  overrides?: Partial<LeadConfig>,
): Layer.Layer<Lead, never, SqlClient | Beacon | BotRegistry | Tank | ExecutorRegistry | TaskStore> =>
  Layer.effect(
    Lead,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const tank = yield* Tank
      const executors = yield* ExecutorRegistry
      const tasks = yield* TaskStore
      const config: LeadConfig = { ...DEFAULT_LEAD_CONFIG, ...overrides }
      const { runTask, abandon } = makeRunner({ beacon, tasks, bots, tank, executors, tiers, config })
      const { startWorker } = makeWorker({ sql, runTask, abandon, config })
      return {
        intake: makeIntake({ sql, beacon, bots, tasks }),
        get: (id) =>
          tasks.get(id).pipe(
            Effect.map(({ spec, state, verdict }) => ({
              spec,
              state,
              ...(verdict === undefined ? {} : { verdict }),
            })),
          ),
        runOnce: (id) => Effect.map(runTask(id), (result) => result.verdict),
        startWorker,
      }
    }),
  )

// Convenience for the composition root: the Lead with its own TaskStore.
export const LeadWithStore = (
  tiers: TierConfig,
  overrides?: Partial<LeadConfig>,
): Layer.Layer<Lead, never, SqlClient | Beacon | BotRegistry | Tank | ExecutorRegistry> =>
  Layer.provide(LeadLive(tiers, overrides), TaskStoreLive)

export { makeOutcomes, type Outcomes, outcomeFor } from "./outcomes.js"
export { DEFAULT_LEAD_CONFIG, type LeadConfig } from "./runner.js"
export { TaskStore, TaskStoreLive } from "./tasks.js"
