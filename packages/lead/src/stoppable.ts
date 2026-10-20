import { Clock, Duration, Effect, Option, Ref } from "effect"
import type { BudgetBreach } from "./budget.js"
import type { RunHandle } from "./control.js"
import { type Outcome, type Progress, withOutcome } from "./verdict.js"

const mark = (progress: Ref.Ref<Progress>, outcome: Outcome) => Ref.update(progress, withOutcome(outcome))

// Records a stop in the round's progress. The round then has no run to show for it.
export const markStopped = (progress: Ref.Ref<Progress>, by: string): Effect.Effect<Option.Option<never>> =>
  mark(progress, { _tag: "Stopped", by }).pipe(Effect.as(Option.none()))

// `run` against the time budget. With `waitedSince` the deadline moves out by the time spent in inline waits, so a
// wait for a person never costs the task its time; without it, a plain timeout.
const withBudgetClock = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  budgetLeftMs: number,
  waitedSince: ((sinceMs: number) => Effect.Effect<number>) | undefined,
): Effect.Effect<Option.Option<A>, E, R> => {
  if (waitedSince === undefined) {
    return run.pipe(Effect.timeoutOption(Duration.millis(Math.max(0, budgetLeftMs))))
  }
  const deadline = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    for (;;) {
      const left = budgetLeftMs + (yield* waitedSince(started)) - ((yield* Clock.currentTimeMillis) - started)
      if (left <= 0) return Option.none<A>()
      yield* Effect.sleep(Duration.millis(left))
    }
  })
  return Effect.raceFirst(Effect.map(run, Option.some), deadline)
}

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
  // Milliseconds the run has spent blocked on an inline approval since `sinceMs`: they do not use up the time budget.
  waitedSince?: (sinceMs: number) => Effect.Effect<number>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.gen(function* () {
    const raced = yield* Effect.raceFirst(
      withBudgetClock(run, budgetLeftMs, waitedSince).pipe(
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
