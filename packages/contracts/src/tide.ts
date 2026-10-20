import { Effect, Schema, Struct } from "effect"
import { Budget } from "./budget.js"
import { ModelTier, TaskKind } from "./enums.js"
import { EventType } from "./events.js"
import { BotId, TideId } from "./ids.js"
import { RepoRef } from "./task.js"

// The task a Tide creates. Title and prompt may hold {{payload.x}} placeholders (rendered by the tides package).
export const TideTemplate = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
  kind: TaskKind,
  tier: ModelTier,
  budget: Budget,
  repo: Schema.optional(RepoRef),
})
export type TideTemplate = typeof TideTemplate.Type

// Equality only: a filter value is a primitive, so a filter cannot carry code or a nested match.
export const FilterValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
export type FilterValue = typeof FilterValue.Type

export const TideName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,79}$/)))

// Defaults of a Tide's limits: a firing inside the cooldown is skipped, and more than the hourly maximum too.
export const DEFAULT_COOLDOWN_SECONDS = 60
export const DEFAULT_MAX_FIRES_PER_HOUR = 30

// Events the tides themselves produce: an event Tide on one of them needs a filter, or it fires on its own output.
export const FEEDBACK_EVENT_TYPES: ReadonlyArray<EventType> = [
  "tide.fired",
  "error.raised",
  "budget.exceeded",
]

export const Tide = Schema.Struct({
  id: TideId,
  botId: BotId,
  name: TideName,
  kind: Schema.Literals(["cron", "event"]),
  cronExpr: Schema.optional(Schema.String),
  // IANA timezone the cron is evaluated in. Validated where the Tide is stored.
  timezone: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  eventType: Schema.optional(EventType),
  // Paths are read from the event object ("payload.action"); the value must be equal to match.
  eventFilter: Schema.optional(Schema.Record(Schema.String, FilterValue)),
  // Minimum seconds between two firings of this Tide (cron or event); a firing inside it is skipped.
  cooldownSeconds: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_COOLDOWN_SECONDS)),
  ),
  // Most firings of this Tide in a rolling hour; beyond it a firing is skipped.
  maxFiresPerHour: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_FIRES_PER_HOUR)),
  ),
  taskTemplate: TideTemplate,
  enabled: Schema.Boolean,
})
export type Tide = typeof Tide.Type

// Input shape for a Tide that the core has not stored yet: the id and the Bot id are assigned by the core.
export const NewTide = Tide.mapFields(Struct.omit(["id", "botId"]))
export type NewTide = typeof NewTide.Type

// A cron Tide names its expression and no event; an event Tide names its event type and no expression.
// Returns the reason it is wrong, or undefined when the shape holds.
export const tideShapeIssue = (
  tide: Pick<Tide, "kind" | "cronExpr" | "eventType" | "eventFilter">,
): string | undefined => {
  if (tide.kind === "cron") {
    if (tide.cronExpr === undefined) return "a cron tide needs cronExpr"
    if (tide.eventType !== undefined || tide.eventFilter !== undefined) {
      return "a cron tide takes no eventType or eventFilter"
    }
    return undefined
  }
  if (tide.eventType === undefined) return "an event tide needs eventType"
  if (tide.cronExpr !== undefined) return "an event tide takes no cronExpr"
  if (
    FEEDBACK_EVENT_TYPES.includes(tide.eventType) &&
    (tide.eventFilter === undefined || Object.keys(tide.eventFilter).length === 0)
  ) {
    return `an event tide on ${tide.eventType} needs an eventFilter`
  }
  return undefined
}
