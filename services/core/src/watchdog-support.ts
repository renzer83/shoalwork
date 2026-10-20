import type { BeaconShape } from "@shoalwork/beacon"
import { Beacon } from "@shoalwork/beacon"
import { BotId, streamIds, TaskId } from "@shoalwork/contracts"
import { Cause, Effect, Schema } from "effect"

// Shared by the watchdog's checks: how a failure is reported, how a check is isolated, how an action is recorded.

export const ACTOR = "system:watchdog"
export const CORRELATION = "watchdog"

export const TaskRow = Schema.Struct({
  id: TaskId,
  bot_id: BotId,
  attempts: Schema.Int,
  state: Schema.String,
  spec: Schema.String,
  updated_at: Schema.String,
})

export const decodeRows = <A, I>(schema: Schema.Codec<A, I>, rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie)

export const describe = (failure: unknown): { readonly tag: string; readonly message: string } => {
  if (failure instanceof Error) return { tag: failure.name, message: failure.message }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
  ) {
    return { tag: failure._tag, message: failure._tag }
  }
  return { tag: "Defect", message: String(failure) }
}

// Reporting a failure must not hide the failure being reported.
export const reportError = (where: string, failure: unknown): Effect.Effect<void, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const { tag, message } = describe(failure)
    yield* beacon
      .append({
        streamId: streamIds.system,
        type: "error.raised",
        payload: { where: `watchdog.${where}`, tag, message },
        actor: ACTOR,
        correlationId: CORRELATION,
      })
      .pipe(Effect.catchCause(() => Effect.void))
  })

// One check: its failure becomes error.raised and a count of zero. Interruption is never swallowed.
export const guarded = <R>(
  where: string,
  check: Effect.Effect<number, unknown, R>,
): Effect.Effect<number, never, R | Beacon> =>
  check.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : reportError(where, Cause.squash(cause)).pipe(Effect.as(0)),
    ),
  )

export const recovered = (
  beacon: BeaconShape,
  what:
    | "stale_task"
    | "stale_job"
    | "long_process"
    | "expired_approval"
    | "state_mismatch"
    | "orphan_worktree",
  ref: string,
  action: string,
) =>
  beacon.append({
    streamId: streamIds.system,
    type: "watchdog.recovered",
    payload: { what, ref, action },
    actor: ACTOR,
    correlationId: CORRELATION,
  })
