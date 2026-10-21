import type { BeaconShape } from "@shoalwork/beacon"
import { GithubWorkflowRunPayload, streamIds } from "@shoalwork/contracts"
import { Cause, Effect, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { awaitingBranch, branchKnown, cursorOf, saveCursor, signalCi } from "./cycle-rows.js"
import { ciSignalOf } from "./cycle-text.js"

const decodeRun = Schema.decodeUnknownOption(GithubWorkflowRunPayload)

// A failure of one task or one step is logged and the pass goes on; only an interruption stops it.
export const isolate =
  (what: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A | undefined, E> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(`factory step failed: ${what}`, cause).pipe(Effect.as(undefined)),
      ),
    )

export const recovered = (beacon: BeaconShape, ref: string, action: string) =>
  beacon.append({
    streamId: streamIds.system,
    type: "watchdog.recovered",
    payload: { what: "state_mismatch", ref, action },
    actor: "system:factory",
    correlationId: "factory",
  })

// The CI conclusions of the log become hints on the cycle of their branch (the cycle confirms them against the
// checks of the pull request before it acts). The cursor stops before a result whose branch no task owns yet while a
// worker is still delivering one: the branch is recorded when the worker's pull request is seen, and the result is
// read again then. A result no delivery waits for is dropped.
export const readCi = (
  sql: SqlClient,
  beacon: BeaconShape,
  slug: string,
  repo: string | undefined,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const after = yield* cursorOf(sql, slug)
    const events = Array.from(yield* Stream.runCollect(beacon.readAll(after, ["github.workflow_run"])))
    let cursor = after
    let held = false
    for (const event of events) {
      const run = decodeRun(event.payload)
      if (Option.isSome(run) && repo !== undefined) {
        const { repo: runRepo, action, conclusion, headBranch } = run.value
        const signal = conclusion === undefined ? undefined : ciSignalOf(conclusion)
        if (runRepo.toLowerCase() === repo && action === "completed" && signal && headBranch !== undefined) {
          const matched = yield* signalCi(sql, slug, headBranch, signal)
          if (
            matched === 0 &&
            !held &&
            !(yield* branchKnown(sql, slug, headBranch)) &&
            (yield* awaitingBranch(sql, slug))
          ) {
            held = true
          }
        }
      }
      if (!held) cursor = event.position
    }
    if (cursor !== after) yield* saveCursor(sql, slug, cursor)
  })
