import { Event, type EventType } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { ApiClient } from "./client.js"
import { CostReport } from "./schemas.js"

// The Farol's reads (T-121). Shapes mirror the core's routes/beacon.ts and packages/beacon projections.
const Nullable = Schema.NullOr(Schema.Number)

export const SavingsReport = Schema.Struct({
  decisions: Schema.Struct({
    total: Schema.Number,
    rule: Schema.Number,
    cache: Schema.Number,
    model: Schema.Number,
    localPct: Nullable,
  }),
  haikuRuns: Schema.Number,
  decisionUsd: Nullable,
  avoidedUsd: Nullable,
  context: Schema.Struct({
    assembled: Schema.Number,
    tokensBefore: Schema.Number,
    tokensAfter: Schema.Number,
    tokensCut: Schema.Number,
    cutPct: Nullable,
    droppedItems: Schema.Number,
    usdPerInputToken: Nullable,
    avoidedUsd: Nullable,
  }),
})
export type SavingsReport = typeof SavingsReport.Type

export const DailyCostList = Schema.Struct({
  days: Schema.Array(Schema.Struct({ day: Schema.String, n: Schema.Number, usd: Schema.Number })),
})
export type DailyCostList = typeof DailyCostList.Type

export const EventFeed = Schema.Struct({
  events: Schema.Array(Event),
  nextBefore: Schema.NullOr(Schema.Number),
})
export type EventFeed = typeof EventFeed.Type

export interface BeaconWindow {
  // ISO-8601 UTC, or relative to now as "<n>h" / "<n>d".
  readonly since?: string | undefined
  readonly until?: string | undefined
}

export interface BeaconCostsQuery extends BeaconWindow {
  readonly by?: "task" | "bot" | "executor" | "tier" | undefined
}

export interface BeaconEventsQuery extends BeaconWindow {
  readonly types?: ReadonlyArray<EventType> | undefined
  readonly stream?: string | undefined
  readonly actor?: string | undefined
  readonly q?: string | undefined
  // Exclusive position bound: the nextBefore of the previous page.
  readonly before?: number | undefined
  readonly limit?: number | undefined
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text === "" ? "" : `?${text}`
}

export const beaconApi = (client: ApiClient) => ({
  costs: (params: BeaconCostsQuery = {}) =>
    client.get(
      `/beacon/costs${query({ by: params.by, since: params.since, until: params.until })}`,
      CostReport,
    ),
  daily: (params: BeaconWindow = {}) =>
    client.get(`/beacon/costs/daily${query({ since: params.since, until: params.until })}`, DailyCostList),
  savings: (params: BeaconWindow = {}) =>
    client.get(`/beacon/savings${query({ since: params.since, until: params.until })}`, SavingsReport),
  events: (params: BeaconEventsQuery = {}) =>
    client.get(
      `/beacon/events${query({
        types: params.types?.join(","),
        stream: params.stream,
        actor: params.actor,
        q: params.q,
        before: params.before,
        limit: params.limit,
        since: params.since,
        until: params.until,
      })}`,
      EventFeed,
    ),
})
