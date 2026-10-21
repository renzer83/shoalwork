import type { Bot, TaskSpec } from "@shoalwork/contracts"
import type { ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import { Effect, Option } from "effect"
import { type Chosen, chooseExecutor } from "./choose.js"
import type { ReplayLink } from "./replay-store.js"

// The executor of a task run: the tier's choice, ranked by the history of the task kind (T-074). The decision is
// recorded under the task's correlation. A reviewer's task excludes the executors it may not use (excludeExecutors).
// A replay (T-122) may name an executor and a model. The executor narrows the Bot's allowed list to that one, so it can
// only pick among what the Bot already allows (a name the Bot does not allow leaves nothing to run: the same blocked
// verdict as no executor); the model replaces the one the tier resolved.
export const chooseForTask = (
  tiers: TierConfig,
  bot: Bot,
  spec: TaskSpec,
  registry: typeof ExecutorRegistry.Service,
  replay?: ReplayLink | undefined,
) =>
  Effect.gen(function* () {
    const overrides = replay?.overrides
    const wanted = overrides?.executor
    const narrowed: Bot =
      wanted === undefined
        ? bot
        : {
            ...bot,
            executors: { ...bot.executors, allowed: bot.executors.allowed.filter((id) => id === wanted) },
          }
    const chosen = yield* chooseExecutor(
      tiers,
      narrowed,
      spec.tier,
      registry,
      spec.review?.excludeExecutors,
      {
        kind: spec.kind,
        correlationId: spec.correlationId ?? spec.id,
      },
    )
    // A model name belongs to one executor: it applies only when that executor is the one chosen.
    const model = overrides?.model
    return model === undefined
      ? chosen
      : Option.map(
          chosen,
          (found): Chosen => (found.executor.id === replay?.modelExecutor ? { ...found, model } : found),
        )
  })
