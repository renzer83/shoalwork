import { Beacon, type BeaconShape, readUsageForBotSince } from "@shoalwork/beacon"
import {
  addUsage,
  type Bot,
  type BotId,
  type Budget,
  exceeds,
  type TaskSpec,
  type Usage,
  usageToBudget,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Clock, Deferred, Effect, Ref } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { botTarget, type ControlShape } from "./control.js"
import type { Lifecycle } from "./lifecycle.js"
import type { Carry } from "./retry.js"
import type { Outcome } from "./verdict.js"
import { describeFailure } from "./verdict.js"

// The limit a run hit: the task's own budget, or the Bot's rolling window. `used` is what the log counts for it.
export interface BudgetBreach {
  readonly scope: "task" | "bot"
  readonly limit: Budget
  readonly used: Budget
}

// The task's budget counts the whole task (earlier rounds included); the Bot's counts its usage in the window.
// Both come from the usage events. The run's wall-clock deadline is not here (stoppable.ts).
export const breachOf = (
  task: { readonly limit: Budget; readonly used: Usage },
  bot: { readonly limit: Budget; readonly used: Usage },
): BudgetBreach | undefined => {
  const taskUsed = usageToBudget(task.used)
  if (exceeds(taskUsed, task.limit).exceeded) return { scope: "task", limit: task.limit, used: taskUsed }
  const botUsed = usageToBudget(bot.used)
  if (exceeds(botUsed, bot.limit).exceeded) return { scope: "bot", limit: bot.limit, used: botUsed }
  return undefined
}

// Default rolling window of a Bot's budget (BUDGET_BOT_WINDOW_HOURS = 24 in services/core).
export const BOT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000

// Whether the Bot already spent more than its budget inside the window.
export const botOverBudget = (
  beacon: BeaconShape,
  bot: Pick<Bot, "id" | "budget">,
  windowMs: number,
): Effect.Effect<boolean, SqlError> =>
  botUsageInWindow(beacon, bot.id, windowMs).pipe(
    Effect.map((used) => exceeds(usageToBudget(used), bot.budget).exceeded),
  )

// Usage the Bot recorded inside its rolling window (`windowMs` before now).
export const botUsageInWindow = (
  beacon: BeaconShape,
  botId: BotId,
  windowMs: number,
): Effect.Effect<Usage, SqlError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* readUsageForBotSince(botId, now - windowMs).pipe(Effect.provideService(Beacon, beacon))
  })

export interface BudgetWatch {
  // Resolves with the breach as soon as one limit is exceeded; never resolves while both hold.
  readonly breached: Effect.Effect<BudgetBreach>
  // Called after a usage event is recorded, with that event's usage (not a running total).
  readonly observe: (usage: Usage) => Effect.Effect<void>
}

export interface WatchInput {
  readonly beacon: BeaconShape
  readonly bot: Pick<Bot, "id" | "budget">
  readonly spec: Pick<TaskSpec, "budget">
  // The previous rounds of the task (their usage counts toward the task budget); undefined for the first round.
  readonly carry: Carry | undefined
  readonly windowMs: number
}

// One watch per round. The Bot's window is read once, when the round starts, and only this round's events are added
// on top, so an event is never counted twice.
export const watchBudgets = (input: WatchInput): Effect.Effect<BudgetWatch, SqlError> =>
  Effect.gen(function* () {
    const before = yield* botUsageInWindow(input.beacon, input.bot.id, input.windowMs)
    const startUsage = input.carry?.usage ?? ZERO_USAGE
    const judge = (task: Usage, round: Usage): BudgetBreach | undefined =>
      breachOf(
        { limit: input.spec.budget, used: task },
        { limit: input.bot.budget, used: addUsage(before, round) },
      )
    const done = yield* Deferred.make<BudgetBreach>()
    const initial = judge(startUsage, ZERO_USAGE)
    if (initial !== undefined) {
      yield* Deferred.succeed(done, initial)
    }
    const totals = yield* Ref.make({ task: startUsage, round: ZERO_USAGE })
    return {
      breached: Deferred.await(done),
      observe: (usage) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(totals, (current) => ({
            task: addUsage(current.task, usage),
            round: addUsage(current.round, usage),
          }))
          const breach = judge(next.task, next.round)
          if (breach !== undefined) {
            yield* Deferred.succeed(done, breach)
          }
        }),
    }
  })

// A Bot whose own window was exceeded stays paused until a resume: its next tasks would only spend more.
// The pause itself is recorded as control.changed by the control.
export const pauseBotOnBreach = (
  control: Pick<ControlShape, "pause">,
  spec: Pick<TaskSpec, "id" | "botId">,
  outcome: Outcome,
  raiseError: Lifecycle["raiseError"],
): Effect.Effect<void> => {
  if (outcome._tag !== "BudgetExceeded" || outcome.scope !== "bot") return Effect.void
  return control
    .pause(botTarget(spec.botId), "system:budget")
    .pipe(
      Effect.catch((error) => raiseError(spec, "lead.budget", error._tag, describeFailure(error).message)),
    )
}
