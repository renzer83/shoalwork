import { BotId, BotState, type SchemaViolation, TaskId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

export type ControlAction = "stop" | "pause" | "resume"
export type ControlCommandError = UsageError | HttpError | SchemaViolation

// Mirrors the answers of POST /control/* and POST /tasks/:id/stop (services/core/src/http/routes/control.ts).
const Stopped = Schema.Struct({ stopped: Schema.Array(TaskId) })
const Done = Schema.Struct({ ok: Schema.Boolean })
const Status = Schema.Struct({
  paused: Schema.Boolean,
  bots: Schema.Array(
    Schema.Struct({
      id: BotId,
      name: Schema.String,
      state: BotState,
      paused: Schema.Boolean,
      running: Schema.Int,
    }),
  ),
})

// Without --bot the action covers everything.
const scopeBody = (flags: Flags): Record<string, string> =>
  flags.bot === undefined ? {} : { bot: flags.bot }

export const controlScope = (
  settings: Settings,
  action: ControlAction,
  flags: Flags,
): Effect.Effect<unknown, ControlCommandError> => {
  const client = new ApiClient(settings.url, settings.token)
  return action === "stop"
    ? client.post("/control/stop", scopeBody(flags), Stopped)
    : client.post(`/control/${action}`, scopeBody(flags), Done)
}

export const controlStopTask = (
  settings: Settings,
  rawId: string,
): Effect.Effect<{ readonly stopped: ReadonlyArray<string> }, ControlCommandError> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(TaskId)(rawId).pipe(
      Effect.mapError(() => new UsageError({ message: `not a task id: ${rawId}` })),
    )
    return yield* new ApiClient(settings.url, settings.token).post(`/tasks/${id}/stop`, {}, Stopped)
  })

export const controlStatus = (settings: Settings) =>
  new ApiClient(settings.url, settings.token).get("/control/status", Status)
