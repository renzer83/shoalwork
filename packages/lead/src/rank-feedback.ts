import type { BeaconShape } from "@shoalwork/beacon"
import { EventPayloads, repoKeyOf, streamIds, type TaskSpec, type Verdict } from "@shoalwork/contracts"
import { recordOutcome } from "@shoalwork/reef"
import { Cause, Effect, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

const decodeAssembled = Schema.decodeUnknownOption(EventPayloads["context.assembled"])

// Ranking feedback (T-096): when a run ends, the code chunks its briefing carried are counted against its verdict
// (ok -> ok + 1, failed -> fail + 1; any other verdict says nothing about the chunks). The chunks are the `used` entries
// of the run's context.assembled: the last one in the task's stream since the previous executor.finished. Called before
// this run's executor.finished is written. It never fails the run: a problem here is only logged.
export const makeRankFeedback =
  (deps: { readonly beacon: BeaconShape; readonly sql: SqlClient }) =>
  (spec: TaskSpec, verdict: Verdict): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (spec.repo === undefined || (verdict.kind !== "ok" && verdict.kind !== "failed")) return
      const events = yield* Stream.runCollect(deps.beacon.readStream(streamIds.task(spec.id), 0))
      let ids: ReadonlyArray<string> = []
      for (const event of events) {
        if (event.type === "executor.finished") {
          ids = []
        } else if (event.type === "context.assembled") {
          const assembled = decodeAssembled(event.payload)
          if (Option.isSome(assembled)) {
            ids = (assembled.value.ranked ?? []).filter((entry) => entry.used).map((entry) => entry.id)
          }
        }
      }
      yield* recordOutcome(repoKeyOf(spec.repo.url), ids, verdict.kind === "ok").pipe(
        Effect.provideService(SqlClient, deps.sql),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("rank feedback not recorded", Cause.pretty(cause)),
      ),
    )
