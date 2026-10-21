import { subscribeEvents } from "@shoalwork/api-client"
import type { Event } from "@shoalwork/contracts"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { useApi } from "../api-context.js"
import {
  type EventFilters,
  eventsQuery,
  liveMatches,
  type PeriodKey,
} from "../components/beacon/beacon-model.js"
import { useLocale } from "../i18n/index.js"

export interface EventsPage {
  readonly events: ReadonlyArray<Event>
  // Pass as `before` for the next page; null when the log has no older match.
  readonly nextBefore: number | null
}

export type EventsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly page: EventsPage; readonly loadingOlder: boolean }
  | { readonly kind: "failed"; readonly message: string }

export interface BeaconEvents {
  readonly load: EventsLoad
  readonly live: boolean
  readonly setLive: (on: boolean) => void
  readonly reload: () => void
  readonly loadMore: () => void
}

const MAX_LIVE_EVENTS = 200

// The event page of the Farol: newest first, paged by position, plus the live feed (prepended while live is on).
export function useBeaconEvents(filters: EventFilters, period: PeriodKey): BeaconEvents {
  const { client, ready } = useApi()
  const { t } = useLocale()
  const [load, setLoad] = useState<EventsLoad>({ kind: "loading" })
  const [live, setLive] = useState(true)
  const [generation, setGeneration] = useState(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  useEffect(() => {
    if (!ready) return
    let current = true
    setLoad({ kind: "loading" })
    void Effect.runPromise(Effect.result(client.beacon.events(eventsQuery(filters, period, undefined)))).then(
      (result) => {
        if (!current) return
        setLoad(
          result._tag === "Success"
            ? {
                kind: "loaded",
                page: { events: result.success.events, nextBefore: result.success.nextBefore },
                loadingOlder: false,
              }
            : { kind: "failed", message: t("beacon.eventsFailed") },
        )
      },
    )
    return () => {
      current = false
    }
  }, [client, ready, filters, period, generation, t])

  // Live events go on top only when they match the applied filters; the feed is dropped while paused.
  useEffect(() => {
    if (!ready || !live) return
    const controller = new AbortController()
    void (async () => {
      for await (const event of subscribeEvents(client, { signal: controller.signal })) {
        if (!liveMatches(event, filtersRef.current)) continue
        setLoad((prev) => {
          if (prev.kind !== "loaded") return prev
          if (prev.page.events.some((known) => known.id === event.id)) return prev
          const events = [event, ...prev.page.events].slice(0, MAX_LIVE_EVENTS)
          return { ...prev, page: { ...prev.page, events } }
        })
      }
    })().catch(() => undefined)
    return () => controller.abort()
  }, [client, ready, live])

  const loadMore = (): void => {
    if (load.kind !== "loaded" || load.page.nextBefore === null || load.loadingOlder) return
    const before = load.page.nextBefore
    setLoad({ ...load, loadingOlder: true })
    void Effect.runPromise(Effect.result(client.beacon.events(eventsQuery(filters, period, before)))).then(
      (result) => {
        setLoad((prev) => {
          if (prev.kind !== "loaded") return prev
          if (result._tag !== "Success") return { ...prev, loadingOlder: false }
          const known = new Set(prev.page.events.map((event) => event.id))
          const older = result.success.events.filter((event) => !known.has(event.id))
          return {
            kind: "loaded",
            loadingOlder: false,
            page: { events: [...prev.page.events, ...older], nextBefore: result.success.nextBefore },
          }
        })
      },
    )
  }

  return { load, live, setLive, reload: () => setGeneration((value) => value + 1), loadMore }
}
