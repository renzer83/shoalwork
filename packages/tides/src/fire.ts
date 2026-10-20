import { Beacon, type BeaconShape, readUsageForBotSince } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type Bot,
  type BotId,
  type Budget,
  type Event,
  exceeds,
  type NewEvent,
  type NotFound,
  type SchemaViolation,
  streamIds,
  type TaskSpec,
  type Tide,
  type TideId,
  usageToBudget,
} from "@shoalwork/contracts"
import type { LeadShape } from "@shoalwork/lead"
import { Data, Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { renderTemplate } from "./render.js"
import type { BrokenTide } from "./row.js"

export const HOUR_MS = 60 * 60 * 1000

// Everything a Tide needs from the rest of the core, injected so tests can run it without the composition root.
export interface TideDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly bots: BotRegistryShape
  readonly lead: LeadShape
  readonly clock: () => Date
  readonly botBudgetWindowMs: number
  // Event types of the enabled event tides: the event path answers other types without a query.
  readonly eventTypes: Set<string>
}

// A cron window whose next run cannot be computed (expression or timezone croner rejects, or one that never matches).
export class ScheduleBroken extends Data.TaggedError("ScheduleBroken")<{
  readonly tideId: TideId
  readonly expr: string
}> {}

export type SkipReason = "paused" | "budget" | "cooldown" | "rate"

export type FireOutcome =
  | { readonly _tag: "fired"; readonly spec: TaskSpec }
  | { readonly _tag: "skipped"; readonly reason: SkipReason }

type Skip =
  | { readonly _tag: "paused" }
  | { readonly _tag: "budget"; readonly limit: Budget; readonly used: Budget }
  | { readonly _tag: "cooldown" }
  | { readonly _tag: "rate"; readonly limit: number }

// Shown as the tag of the error.raised that records a skip. Budget has its own event type, so it has no tag.
const SKIP_TAG = { paused: "BotPaused", cooldown: "Cooldown", rate: "RateLimited" } as const

export const appendEvent = (beacon: BeaconShape, event: NewEvent) =>
  beacon.append(event).pipe(
    Effect.catchTag("SchemaViolation", (error) => Effect.die(error)),
    Effect.catchTag("Conflict", (error) => Effect.die(error)),
    Effect.asVoid,
  )

// Control pauses a Bot with a flag (its own or the global one). Same rule the claim of the task queue applies.
const isPaused = (deps: TideDeps, botId: BotId): Effect.Effect<boolean, SqlError> =>
  deps.sql<{ readonly n: number }>`SELECT 1 AS n FROM control_flags
    WHERE paused = 1 AND (scope = 'global' OR scope = ${`bot:${botId}`}) LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  )

// The Bot's usage inside its rolling window, checked the way Lead.intake checks it. A Tide checks before it creates
// anything, so an over-budget Bot gets no task at all (intake would record a failed one).
const overBudget = (deps: TideDeps, bot: Bot): Effect.Effect<Skip | undefined, SqlError> =>
  Effect.gen(function* () {
    const used = yield* readUsageForBotSince(bot.id, deps.clock().getTime() - deps.botBudgetWindowMs).pipe(
      Effect.provideService(Beacon, deps.beacon),
    )
    const spent = usageToBudget(used)
    return exceeds(spent, bot.budget).exceeded
      ? { _tag: "budget", limit: bot.budget, used: spent }
      : undefined
  })

// Read from the stored last_run_at, which a firing stamps: the cooldown survives a restart.
const cooldownActive = (deps: TideDeps, tide: Tide, now: Date): Effect.Effect<boolean, SqlError> =>
  deps.sql<{ readonly last_run_at: string | null }>`SELECT last_run_at FROM tides WHERE id = ${tide.id}`.pipe(
    Effect.map((rows) => {
      const last = rows[0]?.last_run_at
      return typeof last === "string" && now.getTime() - Date.parse(last) < tide.cooldownSeconds * 1000
    }),
  )

// Read from the log (tide.fired), so the hourly limit does not depend on memory.
const firesSince = (deps: TideDeps, tideId: TideId, since: Date): Effect.Effect<number, SqlError> =>
  deps.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM events
    WHERE type = 'tide.fired' AND occurred_at >= ${since.toISOString()}
      AND json_extract(payload, '$.tideId') = ${tideId}`.pipe(Effect.map((rows) => rows[0]?.n ?? 0))

const skipOf = (deps: TideDeps, tide: Tide, bot: Bot, now: Date): Effect.Effect<Skip | undefined, SqlError> =>
  Effect.gen(function* () {
    if (yield* isPaused(deps, tide.botId)) {
      return { _tag: "paused" } as const
    }
    const budget = yield* overBudget(deps, bot)
    if (budget !== undefined) {
      return budget
    }
    if (yield* cooldownActive(deps, tide, now)) {
      return { _tag: "cooldown" } as const
    }
    const fires = yield* firesSince(deps, tide.id, new Date(now.getTime() - HOUR_MS))
    if (fires >= tide.maxFiresPerHour) {
      return { _tag: "rate", limit: tide.maxFiresPerHour } as const
    }
    return undefined
  })

// A skip is recorded once per tide, per kind, per hour: a tide that keeps being refused writes one line, not one per
// attempt. Its events carry actor system:tides, which the event path never takes as a trigger (triggers.ts).
const recordSkip = (deps: TideDeps, tide: Tide, skip: Skip): Effect.Effect<void, SqlError> => {
  const base = { streamId: streamIds.bot(tide.botId), actor: "system:tides", correlationId: tide.id }
  const raised = (tag: string, message: string): NewEvent => ({
    ...base,
    type: "error.raised",
    payload: { where: "tides.fire", tag, message, botId: tide.botId },
  })
  const event: NewEvent =
    skip._tag === "budget"
      ? {
          ...base,
          type: "budget.exceeded",
          payload: { scope: "bot", refId: tide.botId, limit: skip.limit, used: skip.used },
        }
      : skip._tag === "paused"
        ? raised(SKIP_TAG.paused, `tide ${tide.name} not fired: bot paused`)
        : skip._tag === "cooldown"
          ? raised(
              SKIP_TAG.cooldown,
              `tide ${tide.name} not fired: inside its ${tide.cooldownSeconds}s cooldown`,
            )
          : raised(SKIP_TAG.rate, `tide ${tide.name} not fired: over ${skip.limit} fires in an hour`)
  const tag = skip._tag === "budget" ? null : SKIP_TAG[skip._tag]
  return Effect.gen(function* () {
    const since = new Date(deps.clock().getTime() - HOUR_MS).toISOString()
    const seen = yield* deps.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM events
      WHERE actor = 'system:tides' AND correlation_id = ${tide.id} AND type = ${event.type}
        AND occurred_at >= ${since} AND (${tag} IS NULL OR json_extract(payload, '$.tag') = ${tag})`
    if ((seen[0]?.n ?? 0) === 0) {
      yield* appendEvent(deps.beacon, event)
    }
  })
}

// What one firing carries: the root the {{x.y}} placeholders read, the trigger recorded on tide.fired, and the
// correlation of the task (the source event's, when there is one).
export interface Firing {
  readonly trigger: "cron" | "event"
  readonly root: unknown
  readonly correlationId?: string
}

// Creates the task of one Tide firing: checks pause, budget, cooldown and the hourly limit, intakes the task (origin
// tide), records tide.fired and stamps last_run_at. Runs inside the caller's transaction. A skip is an outcome, not a
// failure, so the caller's transaction still commits the record of it.
export const fireTideWith = (
  deps: TideDeps,
  tide: Tide,
  firing: Firing,
): Effect.Effect<FireOutcome, NotFound | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    const now = deps.clock()
    const bot = yield* deps.bots.get(tide.botId)
    const skip = yield* skipOf(deps, tide, bot, now)
    if (skip !== undefined) {
      yield* recordSkip(deps, tide, skip)
      return { _tag: "skipped", reason: skip._tag } as const
    }
    const template = tide.taskTemplate
    const spec = yield* deps.lead.intake({
      botId: tide.botId,
      title: renderTemplate(template.title, firing.root),
      prompt: renderTemplate(template.prompt, firing.root),
      kind: template.kind,
      tier: template.tier,
      budget: template.budget,
      acceptance: [],
      origin: "tide",
      ...(template.repo === undefined ? {} : { repo: template.repo }),
      ...(firing.correlationId === undefined ? {} : { correlationId: firing.correlationId }),
    })
    yield* appendEvent(deps.beacon, {
      streamId: streamIds.task(spec.id),
      type: "tide.fired",
      payload: { tideId: tide.id, botId: tide.botId, trigger: firing.trigger, taskId: spec.id },
      actor: "system:tides",
      correlationId: spec.id,
    })
    yield* deps.sql`UPDATE tides SET last_run_at = ${now.toISOString()} WHERE id = ${tide.id}`
    return { _tag: "fired", spec } as const
  })

// A cron window or an event of an event Tide: `source` is the event, whose payload feeds the {{payload.x}} placeholders.
export const fireTide = (
  deps: TideDeps,
  tide: Tide,
  source?: Event,
): Effect.Effect<FireOutcome, NotFound | SchemaViolation | SqlError> =>
  fireTideWith(deps, tide, {
    trigger: tide.kind,
    root: source ?? {},
    ...(source === undefined ? {} : { correlationId: source.correlationId }),
  })

export type TideFailure = NotFound | SchemaViolation | ScheduleBroken | BrokenTide | SqlError

const failureText = (error: Exclude<TideFailure, SqlError>): string => {
  switch (error._tag) {
    case "NotFound":
      return `${error.entity} ${error.id} not found`
    case "SchemaViolation":
      return `invalid at ${error.where}`
    case "ScheduleBroken":
      return `no next run for cron "${error.expr}"`
    case "BrokenTide":
      return `stored tide is broken: ${error.reason}`
  }
}

// A permanent failure (the Bot or the template is gone or wrong, the schedule cannot run, the stored row is broken)
// disables that one Tide and says why in error.raised. A database failure keeps the lock, which expires on its own,
// and is recorded once per attempt with the count of attempts so far.
export const handleTideFailure = (
  deps: TideDeps,
  tide: { readonly id: TideId; readonly botId: BotId },
  error: TideFailure,
): Effect.Effect<void> => {
  if (error._tag === "SqlError") {
    return Effect.gen(function* () {
      const seen = yield* deps.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM events
        WHERE actor = 'system:tides' AND correlation_id = ${tide.id} AND type = 'error.raised'
          AND json_extract(payload, '$.tag') = 'SqlError'`
      const attempt = (seen[0]?.n ?? 0) + 1
      yield* appendEvent(deps.beacon, {
        streamId: streamIds.bot(tide.botId),
        type: "error.raised",
        payload: {
          where: "tides.fire",
          tag: "SqlError",
          message: `database failure while firing, attempt ${attempt}`,
          botId: tide.botId,
        },
        actor: "system:tides",
        correlationId: tide.id,
      })
    }).pipe(
      Effect.catch((cause) => Effect.logError("could not record tide database failure", cause._tag)),
      Effect.andThen(
        Effect.logWarning("tide not fired; lock expires and the window is retried", error.reason._tag),
      ),
    )
  }
  const failure: Exclude<TideFailure, SqlError> = error
  return Effect.gen(function* () {
    yield* deps.sql`UPDATE tides SET enabled = 0, locked_at = NULL WHERE id = ${tide.id}`
    yield* appendEvent(deps.beacon, {
      streamId: streamIds.bot(tide.botId),
      type: "error.raised",
      payload: {
        where: "tides.fire",
        tag: failure._tag,
        message: `tide disabled: ${failureText(failure)}`,
        botId: tide.botId,
      },
      actor: "system:tides",
      correlationId: tide.id,
    })
  }).pipe(Effect.catch((cause) => Effect.logError("could not disable tide", cause._tag)))
}
