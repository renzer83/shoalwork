import type { BeaconCostsQuery, BeaconEventsQuery } from "@shoalwork/api-client"
import { type Event, type EventType, EventType as EventTypeSchema } from "@shoalwork/contracts"
import { DateTime, Schema } from "effect"
import type { MessageKey } from "../../i18n/index.js"

// Pure helpers of the Farol (T-121): periods, filter text to query, live matching, number formatting.

export type PeriodKey = "24h" | "7d" | "30d"
export const PERIODS: ReadonlyArray<{ readonly key: PeriodKey; readonly labelKey: MessageKey }> = [
  { key: "24h", labelKey: "beacon.period.24h" },
  { key: "7d", labelKey: "beacon.period.7d" },
  { key: "30d", labelKey: "beacon.period.30d" },
]

// The core caps an events window at 7 days, so a 30-day period shows the last 7 days of events.
export const eventsSince = (period: PeriodKey): "24h" | "7d" => (period === "24h" ? "24h" : "7d")

export type CostDimension = NonNullable<BeaconCostsQuery["by"]>
export const COST_DIMENSIONS: ReadonlyArray<{ readonly key: CostDimension; readonly labelKey: MessageKey }> =
  [
    { key: "tier", labelKey: "beacon.dim.tier" },
    { key: "bot", labelKey: "beacon.dim.bot" },
    { key: "task", labelKey: "beacon.dim.task" },
    { key: "executor", labelKey: "beacon.dim.executor" },
  ]

export const PAGE_SIZE = 50

export interface EventFilters {
  readonly types: string
  readonly stream: string
  readonly actor: string
  readonly q: string
}

export const EMPTY_FILTERS: EventFilters = { types: "", stream: "", actor: "", q: "" }

const clean = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

// Comma-separated event types. Unknown names are reported, not sent: the core would refuse the whole request.
export const parseTypes = (
  raw: string,
): { readonly types: ReadonlyArray<EventType> | undefined; readonly unknown: ReadonlyArray<string> } => {
  const names = (clean(raw) ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  const types: Array<EventType> = []
  const unknown: Array<string> = []
  for (const name of names) {
    if (Schema.is(EventTypeSchema)(name)) {
      if (!types.includes(name)) types.push(name)
    } else {
      unknown.push(name)
    }
  }
  return { types: types.length === 0 ? undefined : types, unknown }
}

export const eventsQuery = (
  filters: EventFilters,
  period: PeriodKey,
  before: number | undefined,
): BeaconEventsQuery => ({
  since: eventsSince(period),
  types: parseTypes(filters.types).types,
  stream: clean(filters.stream),
  actor: clean(filters.actor),
  q: clean(filters.q),
  before,
  limit: PAGE_SIZE,
})

// The same filters applied to a live event, so a paused-off feed shows what the page would show.
export const liveMatches = (event: Event, filters: EventFilters): boolean => {
  const { types } = parseTypes(filters.types)
  if (types !== undefined && !types.includes(event.type)) return false
  const stream = clean(filters.stream)
  if (stream !== undefined && event.streamId !== stream) return false
  const actor = clean(filters.actor)
  if (actor !== undefined && event.actor !== actor) return false
  const q = clean(filters.q)
  if (q === undefined) return true
  return `${event.type} ${JSON.stringify(event.payload)}`.toLowerCase().includes(q.toLowerCase())
}

export const formatUsd = (value: number | null): string => (value === null ? "—" : `US$ ${value.toFixed(4)}`)

export const formatPct = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)}%`)

// Log time in UTC, to the second: the same reading on every machine.
export const formatInstant = (occurredAt: DateTime.Utc): string =>
  new Date(DateTime.toEpochMillis(occurredAt)).toISOString().replace("T", " ").slice(0, 19)

// The bot id of a bot stream ("bot:<id>"), or undefined for any other stream.
export const botIdOf = (streamId: string): string | undefined =>
  streamId.startsWith("bot:") ? streamId.slice("bot:".length) : undefined

// The task id of a task stream ("task:<id>"), or undefined for any other stream: the events a replay can start from.
export const taskIdOf = (streamId: string): string | undefined =>
  streamId.startsWith("task:task_") ? streamId.slice("task:".length) : undefined

// "1.5 s" / "2 min 5 s" for a run time in milliseconds; a negative delta keeps its sign.
export const formatDuration = (ms: number): string => {
  const sign = ms < 0 ? "-" : ""
  const seconds = Math.round(Math.abs(ms) / 1000)
  if (seconds < 60) return `${sign}${(Math.abs(ms) / 1000).toFixed(1)} s`
  return `${sign}${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

// A cost difference with its sign, so "+" and "-" read at a glance.
export const formatUsdDelta = (value: number): string =>
  `${value < 0 ? "-" : "+"}US$ ${Math.abs(value).toFixed(4)}`
