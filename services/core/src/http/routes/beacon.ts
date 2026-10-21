import {
  Beacon,
  COST_BY_TIER_TYPES,
  COST_EVENT_TYPES,
  type CostBy,
  type CostWindow,
  costReport,
  DAILY_COST_EVENT_TYPES,
  dailyCost,
  eventFeed,
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  FEED_MAX_QUERY_LENGTH,
  SAVINGS_EVENT_TYPES,
  savings,
} from "@shoalwork/beacon"
import { Event, EventType } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import type { Hono } from "hono"
import { parseBound } from "./costs.js"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// The Farol's reads (T-121). Every read goes through Beacon.readRange with a bounded window: nothing here reads the
// whole log, and the windows have a ceiling so one request cannot pull months of events.
const DAY_MS = 86_400_000
const MAX_COST_WINDOW_DAYS = 31
const MAX_EVENTS_WINDOW_DAYS = 7
const DEFAULT_COST_WINDOW_DAYS = 7
const DEFAULT_EVENTS_WINDOW_DAYS = 1
const BY_VALUES: ReadonlyArray<CostBy> = ["task", "bot", "executor", "tier"]
const MAX_TEXT_LENGTH = 200

const invalidQuery = (param: string): RouteResponse => ({
  status: 400,
  body: { error: "invalid query", param },
})

type Parsed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly response: RouteResponse }

const fail = (param: string): { readonly ok: false; readonly response: RouteResponse } => ({
  ok: false,
  response: invalidQuery(param),
})

interface WindowParams {
  readonly since: string | undefined
  readonly until: string | undefined
}

// since defaults to `defaultDays` before now, until to now. The window must be non-empty and at most `maxDays` long.
const parseWindow = (
  params: WindowParams,
  now: number,
  defaultDays: number,
  maxDays: number,
): Parsed<CostWindow> => {
  const since = params.since === undefined ? now - defaultDays * DAY_MS : parseBound(params.since, now)
  if (since === undefined) return fail("since")
  const until = params.until === undefined ? now : parseBound(params.until, now)
  if (until === undefined || until <= since) return fail("until")
  if (until - since > maxDays * DAY_MS) return fail("since")
  return { ok: true, value: { since, until } }
}

const parseCostBy = (raw: string | undefined): Parsed<CostBy> => {
  const by = raw === undefined ? "task" : BY_VALUES.find((value) => value === raw)
  return by === undefined ? fail("by") : { ok: true, value: by }
}

// Costs: GET /beacon/costs?by=task|bot|executor|tier&since=&until=
export const parseBeaconCostsQuery = (
  params: WindowParams & { readonly by: string | undefined },
  now: number,
): Parsed<{ readonly by: CostBy; readonly window: CostWindow }> => {
  const by = parseCostBy(params.by)
  if (!by.ok) return by
  const window = parseWindow(params, now, DEFAULT_COST_WINDOW_DAYS, MAX_COST_WINDOW_DAYS)
  if (!window.ok) return window
  return { ok: true, value: { by: by.value, window: window.value } }
}

// Events: GET /beacon/events?types=&stream=&actor=&q=&since=&until=&before=&limit=
export interface BeaconEventsQuery {
  readonly types: ReadonlyArray<EventType>
  readonly window: CostWindow
  readonly stream: string | undefined
  readonly actor: string | undefined
  readonly q: string | undefined
  readonly before: number | undefined
  readonly limit: number
}

export interface BeaconEventsParams extends WindowParams {
  readonly types: string | undefined
  readonly stream: string | undefined
  readonly actor: string | undefined
  readonly q: string | undefined
  readonly before: string | undefined
  readonly limit: string | undefined
}

const parseTypes = (raw: string | undefined): Parsed<ReadonlyArray<EventType>> => {
  if (raw === undefined || raw === "") return { ok: true, value: EventType.literals }
  const types: Array<EventType> = []
  for (const name of raw.split(",").map((part) => part.trim())) {
    if (!Schema.is(EventType)(name)) return fail("types")
    if (!types.includes(name)) types.push(name)
  }
  return { ok: true, value: types }
}

// Optional text filter: empty is absent, and longer than `maxLength` is refused.
const parseText = (raw: string | undefined, param: string, maxLength: number): Parsed<string | undefined> => {
  if (raw === undefined || raw === "") return { ok: true, value: undefined }
  return raw.length > maxLength ? fail(param) : { ok: true, value: raw }
}

const parseInteger = (
  raw: string | undefined,
  param: string,
  min: number,
  max: number,
): Parsed<number | undefined> => {
  if (raw === undefined) return { ok: true, value: undefined }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? { ok: true, value } : fail(param)
}

export const parseBeaconEventsQuery = (
  params: BeaconEventsParams,
  now: number,
): Parsed<BeaconEventsQuery> => {
  const types = parseTypes(params.types)
  if (!types.ok) return types
  const window = parseWindow(params, now, DEFAULT_EVENTS_WINDOW_DAYS, MAX_EVENTS_WINDOW_DAYS)
  if (!window.ok) return window
  const stream = parseText(params.stream, "stream", MAX_TEXT_LENGTH)
  if (!stream.ok) return stream
  const actor = parseText(params.actor, "actor", MAX_TEXT_LENGTH)
  if (!actor.ok) return actor
  const q = parseText(params.q, "q", FEED_MAX_QUERY_LENGTH)
  if (!q.ok) return q
  const before = parseInteger(params.before, "before", 1, Number.MAX_SAFE_INTEGER)
  if (!before.ok) return before
  const limit = parseInteger(params.limit, "limit", 1, FEED_MAX_LIMIT)
  if (!limit.ok) return limit
  return {
    ok: true,
    value: {
      types: types.value,
      window: window.value,
      stream: stream.value,
      actor: actor.value,
      q: q.value,
      before: before.value,
      limit: limit.value ?? FEED_DEFAULT_LIMIT,
    },
  }
}

const readCosts = (by: CostBy, window: CostWindow): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const types = by === "tier" ? COST_BY_TIER_TYPES : COST_EVENT_TYPES
    const events = yield* Stream.runCollect(beacon.readRange(types, window))
    return {
      status: 200,
      body: costReport(Array.from(events), { current: window }, by),
    } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const readDaily = (window: CostWindow): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readRange(DAILY_COST_EVENT_TYPES, window))
    const days = dailyCost(Array.from(events), window)
    return { status: 200, body: { days } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const readSavings = (window: CostWindow): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readRange(SAVINGS_EVENT_TYPES, window))
    return { status: 200, body: savings(Array.from(events), window) } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const readEvents = (query: BeaconEventsQuery): Effect.Effect<RouteResponse, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readRange(query.types, query.window))
    const page = eventFeed(
      Array.from(events),
      { stream: query.stream, actor: query.actor, q: query.q },
      { before: query.before, limit: query.limit },
    )
    const encoded = yield* Schema.encodeEffect(Schema.Array(Event))(Array.from(page.events)).pipe(
      Effect.orDie,
    )
    return { status: 200, body: { events: encoded, nextBefore: page.nextBefore } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerBeaconRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/beacon/costs", async (c) => {
    const parsed = parseBeaconCostsQuery(
      { by: c.req.query("by"), since: c.req.query("since"), until: c.req.query("until") },
      Date.now(),
    )
    if (!parsed.ok) return sendResponse(c, parsed.response)
    return sendResponse(c, await runEffect(readCosts(parsed.value.by, parsed.value.window)))
  })

  app.get("/beacon/costs/daily", async (c) => {
    const parsed = parseWindow(
      { since: c.req.query("since"), until: c.req.query("until") },
      Date.now(),
      DEFAULT_COST_WINDOW_DAYS,
      MAX_COST_WINDOW_DAYS,
    )
    if (!parsed.ok) return sendResponse(c, parsed.response)
    return sendResponse(c, await runEffect(readDaily(parsed.value)))
  })

  app.get("/beacon/savings", async (c) => {
    const parsed = parseWindow(
      { since: c.req.query("since"), until: c.req.query("until") },
      Date.now(),
      DEFAULT_COST_WINDOW_DAYS,
      MAX_COST_WINDOW_DAYS,
    )
    if (!parsed.ok) return sendResponse(c, parsed.response)
    return sendResponse(c, await runEffect(readSavings(parsed.value)))
  })

  app.get("/beacon/events", async (c) => {
    const parsed = parseBeaconEventsQuery(
      {
        types: c.req.query("types"),
        stream: c.req.query("stream"),
        actor: c.req.query("actor"),
        q: c.req.query("q"),
        before: c.req.query("before"),
        limit: c.req.query("limit"),
        since: c.req.query("since"),
        until: c.req.query("until"),
      },
      Date.now(),
    )
    if (!parsed.ok) return sendResponse(c, parsed.response)
    return sendResponse(c, await runEffect(readEvents(parsed.value)))
  })
}
