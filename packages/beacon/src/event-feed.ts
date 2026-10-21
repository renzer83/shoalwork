import type { Event } from "@shoalwork/contracts"

// The Farol's log page (T-121). Pure over events already windowed and typed by Beacon.readRange; the filters that
// Beacon cannot express (stream, actor, free text) are applied here, in one linear pass.

export const FEED_MAX_LIMIT = 500
export const FEED_DEFAULT_LIMIT = 100
export const FEED_MAX_QUERY_LENGTH = 200

export interface FeedFilter {
  readonly stream?: string | undefined
  readonly actor?: string | undefined
  // Case-insensitive substring of the event type or of its payload JSON. Length is capped by the caller.
  readonly q?: string | undefined
}

export interface FeedOptions {
  // Exclusive position bound: the nextBefore of the previous page. Absent: from the newest event.
  readonly before?: number | undefined
  readonly limit: number
}

export interface FeedPage {
  // Newest first.
  readonly events: ReadonlyArray<Event>
  // Pass as `before` to get the next (older) page; null when there is none.
  readonly nextBefore: number | null
}

const matches = (event: Event, filter: FeedFilter, needle: string | undefined): boolean => {
  if (filter.stream !== undefined && event.streamId !== filter.stream) return false
  if (filter.actor !== undefined && event.actor !== filter.actor) return false
  if (needle === undefined) return true
  return `${event.type} ${JSON.stringify(event.payload)}`.toLowerCase().includes(needle)
}

// Walks the events from the newest down and stops one match past the page, so `nextBefore` is known without a count.
// Pass the events in log order (ascending position).
export const eventFeed = (
  events: ReadonlyArray<Event>,
  filter: FeedFilter,
  options: FeedOptions,
): FeedPage => {
  const needle = filter.q === undefined || filter.q === "" ? undefined : filter.q.toLowerCase()
  const page: Array<Event> = []
  let more = false
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined) continue
    if (options.before !== undefined && event.position >= options.before) continue
    if (!matches(event, filter, needle)) continue
    if (page.length === options.limit) {
      more = true
      break
    }
    page.push(event)
  }
  const last = page[page.length - 1]
  return { events: page, nextBefore: more && last !== undefined ? last.position : null }
}
