import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { ExecutorRegistry, type TierConfig } from "@shoalwork/executors"
import { Tank } from "@shoalwork/tank"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { makeIntake } from "./intake.js"
import { Lead } from "./lead.js"
import { DEFAULT_LEAD_CONFIG, type LeadConfig, makeRunner } from "./runner.js"
import { TaskStore, TaskStoreLive } from "./tasks.js"
import { makeWorker } from "./worker.js"

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
        abandon,
        intake: makeIntake({ sql, beacon, bots, tasks, routing: tiers.routing }),
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

export { type Chat, ChatFailure, makeChat } from "./chat.js"
export {
  Conversation,
  ConversationLive,
  type ConversationOptions,
  type ConversationShape,
} from "./conversation.js"
export { ESCALATION_MIN_CHARS, escalate, parseChoice } from "./escalation.js"
export {
  CONSOLIDATE_QUEUE,
  type ConsolidateHookOptions,
  executorConsolidationModel,
  startConsolidateHook,
} from "./hooks/consolidate.js"
export { TASKS_QUEUE } from "./intake.js"
export { Lead, type LeadShape } from "./lead.js"
export { makeOutcomes, type Outcomes, outcomeFor } from "./outcomes.js"
export { DEFAULT_LEAD_CONFIG, type LeadConfig } from "./runner.js"
export { TaskStore, TaskStoreLive } from "./tasks.js"
export { stepIdFor } from "./verdict.js"
