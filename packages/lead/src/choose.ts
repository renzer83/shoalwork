import type { Bot, Effort, ExecutorId, ModelTier, NotFound } from "@shoalwork/contracts"
import { type Executor, type ExecutorRegistry, resolveTier, type TierConfig } from "@shoalwork/executors"
import { Effect, Option } from "effect"

// What a task runs with: the executor, and the model and effort the tier table (or the Bot override) resolved.
export interface Chosen {
  readonly executor: Executor
  readonly model: string
  readonly effort?: Effort
}

// The executor that serves a task's tier, via resolveTier: the Bot's override for the tier, then the global table, then
// the first available alternative. Two policies apply first:
//   - bot.executors.allowed is policy: an executor outside it counts as unavailable (primary or alternative).
//   - bot.executors.preferred does not decide; the tier does.
// `exclude` (a reviewer's task): executors that may never serve it, whatever the table or an override says.
// None when no candidate is allowed, registered and available; the runner then records a blocked verdict.
export const chooseExecutor = (
  tiers: TierConfig,
  bot: Bot,
  tier: ModelTier,
  registry: typeof ExecutorRegistry.Service,
  exclude: ReadonlyArray<ExecutorId> = [],
): Effect.Effect<Option.Option<Chosen>, NotFound> =>
  Effect.gen(function* () {
    const allowed = registry.list().filter((id) => bot.executors.allowed.includes(id))
    const executors = yield* Effect.forEach(allowed, (id) => registry.get(id))
    const resolved = yield* resolveTier(tiers, bot.modelTiers, tier, executors, { exclude }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (resolved === undefined) {
      return Option.none()
    }
    const executor = executors.find((candidate) => candidate.id === resolved.executor)
    if (executor === undefined) {
      return Option.none()
    }
    return Option.some({
      executor,
      model: resolved.model,
      ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    })
  })
