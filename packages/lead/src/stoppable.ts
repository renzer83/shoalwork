import { Duration, Effect, Option, Ref } from "effect"
import type { BudgetBreach } from "./budget.js"
import type { RunHandle } from "./control.js"
import { type Outcome, type Progress, withOutcome } from "./verdict.js"

const mark = (progress: Ref.Ref<Progress>, outcome: Outcome) => Ref.update(progress, withOutcome(outcome))

// Records a stop in the round's progress. The round then has no run to show for it.
export const markStopped = (progress: Ref.Ref<Progress>, by: string): Effect.Effect<Option.Option<never>> =>
  mark(progress, { _tag: "Stopped", by }).pipe(Effect.as(Option.none()))

// Runs `run` against the task's time budget, its stop signal and its budget watch. Resolves with the run's result, or
// none when the time budget ran out (outcome TimedOut), a stop was requested (outcome Stopped) or a budget was exceeded
// (outcome BudgetExceeded). Whichever loses is interrupted, and its finalizers (Tank processes, worktree release)
// finish before this resolves.
export const raceWithStop = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  handle: RunHandle,
  budgetLeftMs: number,
  progress: Ref.Ref<Progress>,
  breached: Effect.Effect<BudgetBreach>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.gen(function* () {
    const raced = yield* Effect.raceFirst(
      run.pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, budgetLeftMs))),
        Effect.map((finished) => ({ _tag: "Ran" as const, finished })),
      ),
      Effect.raceFirst(
        handle.stopRequested.pipe(Effect.map((by) => ({ _tag: "Stopped" as const, by }))),
        breached.pipe(Effect.map((breach) => ({ _tag: "Breached" as const, breach }))),
      ),
    )
    if (raced._tag === "Stopped") {
      return yield* markStopped(progress, raced.by)
    }
    if (raced._tag === "Breached") {
      yield* mark(progress, { _tag: "BudgetExceeded", ...raced.breach })
      return Option.none()
    }
    if (Option.isNone(raced.finished)) {
      yield* mark(progress, { _tag: "TimedOut" })
    }
    return raced.finished
  })
