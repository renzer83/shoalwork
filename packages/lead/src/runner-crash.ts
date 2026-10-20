import type { EventType, TaskId } from "@shoalwork/contracts"
import { Cause, Effect } from "effect"
import type { RunResult } from "./runner.js"
import { blockedVerdict, clip, describeFailure, isNotFound, SUMMARY_MAX } from "./verdict.js"

// What a run that crashed (a defect or an unexpected failure) comes to: a blocked verdict and an error.raised.
// An interruption stays an interruption.
export const crashResult =
  (taskEvent: (id: TaskId, type: EventType, payload: unknown) => Effect.Effect<void>, id: TaskId) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<RunResult> => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.interrupt
    }
    const failure = Cause.squash(cause)
    const { tag, message } = describeFailure(failure)
    return taskEvent(id, "error.raised", { where: "lead.runOnce", tag, message, taskId: id }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.as({
        verdict: blockedVerdict(clip(`${tag}: ${message}`, SUMMARY_MAX), tag),
        // A task that does not exist will not appear on a retry; any other failure may be transient.
        recorded: isNotFound(failure),
        stopped: false,
      }),
    )
  }
