import { getTimeline, type HttpError, subscribeEvents } from "@shoalwork/api-client"
import type { SchemaViolation, TimelineItem } from "@shoalwork/contracts"
import { Effect } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "../api-context.js"
import { LIVE_TYPES, lastPosition, mergeItems, reactTo, withApprovalStatus } from "./timeline-model.js"

const PAGE_SIZE = 50
const DELTA_LIMIT = 500
const REFRESH_DEBOUNCE_MS = 250

export interface BotTimeline {
  readonly items: ReadonlyArray<TimelineItem>
  readonly status: "loading" | "ready" | "failed"
  readonly error: string | undefined
  // The live feed dropped and is being retried.
  readonly liveError: string | undefined
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  readonly loadOlder: () => void
  readonly reload: () => void
  // Pull what happened since the last item (used right after sending a message).
  readonly refresh: () => void
  // Reflect a decision made from this app before the live event arrives.
  readonly markApproval: (approvalId: string, status: "approved" | "denied" | "expired", by?: string) => void
}

const describe = (error: HttpError | SchemaViolation, baseUrl: string): string => {
  if (error._tag === "HttpError") {
    return error.status === 0
      ? `Cannot reach the core at ${baseUrl}`
      : `The core answered HTTP ${error.status}`
  }
  return "The core answered with an unexpected body"
}

// The conversation with one Bot (id or name): the newest page, older pages on demand, and the live feed.
export function useBotTimeline(bot: string): BotTimeline {
  const { client, config, ready } = useApi()
  const [items, setItems] = useState<ReadonlyArray<TimelineItem>>([])
  const [status, setStatus] = useState<BotTimeline["status"]>("loading")
  const [error, setError] = useState<string | undefined>(undefined)
  const [liveError, setLiveError] = useState<string | undefined>(undefined)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [generation, setGeneration] = useState(0)
  const itemsRef = useRef<ReadonlyArray<TimelineItem>>([])
  const refreshRef = useRef<() => void>(() => undefined)
  // Counts conversations (a Bot, or a reload); an answer that belongs to an older one is dropped.
  const epochRef = useRef(0)
  const baseUrl = config.baseUrl

  const apply = useCallback((next: ReadonlyArray<TimelineItem>) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  // One effect owns the whole lifetime of a conversation: first page, then the feed from the page's head.
  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    // A new conversation starts empty: nothing of the previous Bot stays on screen or in the cursors.
    epochRef.current += 1
    itemsRef.current = []
    setItems([])
    setNextBefore(null)
    setLoadingOlder(false)
    let botId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let dirty = false
    setStatus("loading")
    setError(undefined)
    setLiveError(undefined)

    const fetchDelta = async (): Promise<void> => {
      if (inFlight) {
        dirty = true
        return
      }
      inFlight = true
      try {
        do {
          dirty = false
          const result = await Effect.runPromise(
            Effect.result(
              getTimeline(client, bot, { after: lastPosition(itemsRef.current), limit: DELTA_LIMIT }),
            ),
          )
          if (abort.signal.aborted) return
          if (result._tag === "Success") {
            apply(mergeItems(itemsRef.current, result.success.items))
          } else {
            setLiveError(describe(result.failure, baseUrl))
          }
        } while (dirty)
      } finally {
        inFlight = false
      }
    }
    refreshRef.current = () => {
      void fetchDelta()
    }

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        void fetchDelta()
      }, REFRESH_DEBOUNCE_MS)
    }

    const run = async (): Promise<void> => {
      const first = await Effect.runPromise(Effect.result(getTimeline(client, bot, { limit: PAGE_SIZE })))
      if (abort.signal.aborted) return
      if (first._tag === "Failure") {
        setStatus("failed")
        setError(describe(first.failure, baseUrl))
        return
      }
      botId = first.success.botId
      apply(mergeItems([], first.success.items))
      setNextBefore(first.success.nextBefore)
      setStatus("ready")
      try {
        for await (const event of subscribeEvents(client, {
          types: LIVE_TYPES,
          lastEventId: first.success.head,
          signal: abort.signal,
          onError: (failure) => setLiveError(describe(failure, baseUrl)),
        })) {
          setLiveError(undefined)
          const reaction = reactTo(event, botId)
          if (reaction.kind === "resolved") {
            apply(withApprovalStatus(itemsRef.current, reaction.approvalId, reaction.status, reaction.by))
          } else if (reaction.kind === "refresh") {
            schedule()
          }
        }
      } catch (failure) {
        // A 4xx other than 408/429 ends the feed for good (bad token): say so instead of retrying.
        if (!abort.signal.aborted) {
          setLiveError(failure instanceof Error ? failure.message : "The live feed stopped")
        }
      }
    }
    void run()

    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
      refreshRef.current = () => undefined
    }
  }, [client, bot, ready, baseUrl, generation, apply])

  const loadOlder = useCallback(() => {
    if (nextBefore === null || loadingOlder) return
    const epoch = epochRef.current
    setLoadingOlder(true)
    void Effect.runPromise(
      Effect.result(getTimeline(client, bot, { before: nextBefore, limit: PAGE_SIZE })),
    ).then((result) => {
      // The Bot changed (or the screen reloaded) while this page was on its way.
      if (epoch !== epochRef.current) return
      setLoadingOlder(false)
      if (result._tag === "Success") {
        apply(mergeItems(itemsRef.current, result.success.items))
        setNextBefore(result.success.nextBefore)
      } else {
        setLiveError(describe(result.failure, baseUrl))
      }
    })
  }, [client, bot, nextBefore, loadingOlder, apply, baseUrl])

  const markApproval = useCallback(
    (approvalId: string, next: "approved" | "denied" | "expired", by?: string) => {
      apply(withApprovalStatus(itemsRef.current, approvalId, next, by))
    },
    [apply],
  )

  return {
    items,
    status,
    error,
    liveError,
    hasOlder: nextBefore !== null,
    loadingOlder,
    loadOlder,
    reload: () => setGeneration((value) => value + 1),
    refresh: () => refreshRef.current(),
    markApproval,
  }
}
