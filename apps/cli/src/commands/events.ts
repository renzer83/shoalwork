import type { SchemaViolation } from "@shoalwork/contracts"
import { Event } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

const EventsBody = Schema.Struct({ events: Schema.Array(Event) })
export type EventsBody = typeof EventsBody.Type

// Reads one stream from the version after `--after` (default 0). The core caps the page at 500 events.
export const eventsList = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<EventsBody, UsageError | HttpError | SchemaViolation> =>
  Effect.gen(function* () {
    const stream = flags.stream
    if (stream === undefined || stream === "") {
      return yield* Effect.fail(new UsageError({ message: "missing --stream <stream id>, e.g. task:<id>" }))
    }
    const after = flags.after ?? "0"
    if (!/^\d+$/.test(after)) {
      return yield* Effect.fail(new UsageError({ message: "--after expects a non-negative integer" }))
    }
    const query = new URLSearchParams({ stream, after })
    return yield* new ApiClient(settings.url, settings.token).get(`/events?${query.toString()}`, EventsBody)
  })
