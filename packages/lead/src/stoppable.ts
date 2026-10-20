import { Duration, Effect, Option, Ref } from "effect"
import type { RunHandle } from "./control.js"
import { type Outcome, type Progress, withOutcome } from "./verdict.js"

const mark = (progress: Ref.Ref<Progress>, outcome: Outcome) => Ref.update(progress, withOutcome(outcome))

// Records a stop in the round's progress. The round then has no run to show for it.
export const markStopped = (progress: Ref.Ref<Progress>, by: string): Effect.Effect<Option.Option<never>> =>
  mark(progress, { _tag: "Stopped", by }).pipe(Effect.as(Option.none()))

// Runs `run` against the task's time budget and its stop signal. Resolves with the run's result, or none when the
// budget ran out (outcome TimedOut) or a stop was requested (outcome Stopped). Whichever loses is interrupted, and
// its finalizers (Tank processes, worktree release) finish before this resolves.
export const raceWithStop = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  handle: RunHandle,
  budgetLeftMs: number,
  progress: Ref.Ref<Progress>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.gen(function* () {
    const raced = yield* Effect.raceFirst(
      run.pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, budgetLeftMs))),
        Effect.map((finished) => ({ _tag: "Ran" as const, finished })),
      ),
      handle.stopRequested.pipe(Effect.map((by) => ({ _tag: "Stopped" as const, by }))),
    )
    if (raced._tag === "Stopped") {
      return yield* markStopped(progress, raced.by)
    }
    if (Option.isNone(raced.finished)) {
      yield* mark(progress, { _tag: "TimedOut" })
    }
    return raced.finished
  })
