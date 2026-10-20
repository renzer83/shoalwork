import type { Event, Tide } from "@shoalwork/contracts"
import { Cause, Effect, type Scope, Stream } from "effect"
import { appendEvent, fireTide, handleTideFailure, type TideDeps, tideSkippedEvent } from "./fire.js"
import { lookupPath, tideMatches } from "./render.js"
import { BrokenTide, decodeTideRows, type TideRow, tideFromRow } from "./row.js"

const logDefect = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("event tide handler failed")

// The Bot's own GitHub work (a PR, push or check from its own branch in this repo, T-045) is marked by the flag.
export const isBotOwnEvent = (event: Event): boolean => lookupPath(event, "payload.botAuthored") === true

// Events the tides themselves write, and tide.fired, never trigger a tide: a tide on its own output would loop.
// The Bot's own work counts as feedback too, and a Tide reacts to it only by opting in (see optsInToBotOwn).
export const isFeedback = (event: Event): boolean =>
  event.actor.startsWith("system:tides") || event.type === "tide.fired" || isBotOwnEvent(event)

// Opt-in for feedback of the Bot's own work: the filter must name the flag with true, e.g. {"payload.botAuthored": true}.
export const optsInToBotOwn = (tide: Pick<Tide, "eventFilter">, event: Event): boolean =>
  !isBotOwnEvent(event) || tide.eventFilter?.["payload.botAuthored"] === true

// One tide of one event. Its own failures are isolated: a broken tide is disabled and the next one still runs.
// Feedback never fires a tide: the Bot's own work fires only the tides that opt in. Any other held-back match is recorded
// as tide.skipped (reason feedback), so the skip is visible instead of silent.
const fireOnEvent = (deps: TideDeps, row: TideRow, event: Event): Effect.Effect<void> =>
  Effect.gen(function* () {
    const tide = yield* tideFromRow(row)
    if (!tideMatches(tide, event)) {
      return
    }
    if (isFeedback(event) && !(isBotOwnEvent(event) && optsInToBotOwn(tide, event))) {
      yield* appendEvent(deps.beacon, tideSkippedEvent(tide, "feedback"))
      return
    }
    yield* deps.sql.withTransaction(fireTide(deps, tide, event))
  }).pipe(
    Effect.catch((error) => handleTideFailure(deps, { id: row.id, botId: row.bot_id }, error)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : handleTideFailure(
            deps,
            { id: row.id, botId: row.bot_id },
            new BrokenTide({ id: row.id, botId: row.bot_id, reason: "unexpected failure" }),
          ),
    ),
  )

// Each enabled event Tide of this event's type is checked against its filter. The event types are in memory
// (eventTypes), so an event nobody listens to costs no query. Never fails. A tide.skipped is never answered: a Tide that
// listens to it would otherwise write the next one forever.
export const handleEvent = (deps: TideDeps, event: Event): Effect.Effect<void> => {
  if (!deps.eventTypes.has(event.type) || event.type === "tide.skipped") {
    return Effect.void
  }
  return Effect.gen(function* () {
    const rows = yield* deps.sql`SELECT * FROM tides
      WHERE kind = 'event' AND enabled = 1 AND event_type = ${event.type}`
    yield* Effect.forEach(yield* decodeTideRows(rows), (row) => fireOnEvent(deps, row, event), {
      discard: true,
    })
  }).pipe(
    Effect.catch((error) => Effect.logWarning("event tides not evaluated", error._tag)),
    Effect.catchCause(logDefect),
  )
}

// Attaches to the live feed before it returns (Beacon.subscribe). The subscription and its consumer end with the Scope.
export const startEventTriggers = (deps: TideDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* deps.beacon.subscribe()
    yield* Effect.forkScoped(Stream.runForEach(events, (event) => handleEvent(deps, event)))
  })
