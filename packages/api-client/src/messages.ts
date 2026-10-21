import { EventPayloads, TimelinePage } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { ApiClient } from "./client.js"

// The chat routes of the core (T-113): POST /messages and GET /messages, as functions over an ApiClient.

export const MessageAccepted = Schema.Struct({ eventId: Schema.String })
export type MessageAccepted = typeof MessageAccepted.Type

export interface TimelineQuery {
  // Newest page when both are absent; older than this position with `before`, newer than it with `after`.
  readonly before?: number
  readonly after?: number
  readonly limit?: number
}

const queryString = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value))
    }
  }
  return search.toString()
}

// `bot` is a Bot id or name ("lead").
export const getTimeline = (client: ApiClient, bot: string, query: TimelineQuery = {}) =>
  client.get(
    `/messages?${queryString({ botId: bot, before: query.before, after: query.after, limit: query.limit })}`,
    TimelinePage,
  )

export const sendMessage = (client: ApiClient, bot: string, text: string) =>
  client.post("/messages", { botId: bot, text }, MessageAccepted)

// Payload decoders for the live feed. They live here, next to the contracts, so the schemas are always run by the
// same copy of Effect that built them (an app bundle can end up with two).
export const decodeApprovalResolved = Schema.decodeUnknownOption(EventPayloads["approval.resolved"])
export const decodeExecutorEventPayload = Schema.decodeUnknownOption(EventPayloads["executor.event"])
