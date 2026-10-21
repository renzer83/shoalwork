import type { Bot, TaskSpec } from "@shoalwork/contracts"
import type { ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import { chooseExecutor } from "./choose.js"

// The executor of a task run: the tier's choice, ranked by the history of the task kind (T-074). The decision is
// recorded under the task's correlation. A reviewer's task excludes the executors it may not use (excludeExecutors).
export const chooseForTask = (
  tiers: TierConfig,
  bot: Bot,
  spec: TaskSpec,
  registry: typeof ExecutorRegistry.Service,
) =>
  chooseExecutor(tiers, bot, spec.tier, registry, spec.review?.excludeExecutors, {
    kind: spec.kind,
    correlationId: spec.correlationId ?? spec.id,
  })
