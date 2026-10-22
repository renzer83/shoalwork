import { getTimeline, subscribeEvents } from "@shoalwork/api-client"
import type { TimelineItem } from "@shoalwork/contracts"
import { DateTime, Effect } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import { useApi } from "../api-context.js"
import type { BotPreview } from "../shell/bot-groups.js"

const PAGE = 20
// A Bot whose newest 60 timeline entries hold no message (a long run of commands) shows no preview.
export const MAX_PREVIEW_PAGES = 3
const DEBOUNCE_MS = 400
export const RECONNECT_INITIAL_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

// The newest message of a page of timeline items, if there is one.
export const lastMessage = (items: ReadonlyArray<TimelineItem>): BotPreview | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === "message") {
      return { text: item.text, at: DateTime.toEpochMillis(item.occurredAt) }
    }
  }
  return undefined
}

const botIdOf = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const value: unknown = Reflect.get(payload, "botId")
  return typeof value === "string" ? value : undefined
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

export interface PreviewOptions {
  // First pause before the live feed is opened again after it ended; doubles up to 30 s. Test seam.
  readonly reconnectMs?: number
}

// The last message of each Bot for the sidebar rows. One timeline read per Bot (older pages, up to three, when the
// newest holds no message), then a re-read of the Bot a live message event is about (or of all of them when the event
// does not say which). The live feed is opened again, with a growing pause, whenever it ends for any reason but the
// hook going away.
export function useBotPreviews(
  botIds: ReadonlyArray<string>,
  options: PreviewOptions = {},
): Readonly<Record<string, BotPreview>> {
  const { client } = useApi()
  const [previews, setPreviews] = useState<Readonly<Record<string, BotPreview>>>({})
  const key = useMemo(() => [...botIds].sort().join(","), [botIds])
  const idsRef = useRef<ReadonlyArray<string>>([])
  idsRef.current = key === "" ? [] : key.split(",")
  const reconnectMs = options.reconnectMs ?? RECONNECT_INITIAL_MS

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Set<string>()

    const read = async (id: string): Promise<void> => {
      let before: number | undefined
      for (let pageNumber = 0; pageNumber < MAX_PREVIEW_PAGES; pageNumber += 1) {
        const result = await Effect.runPromise(
          Effect.result(
            getTimeline(client, id, { limit: PAGE, ...(before === undefined ? {} : { before }) }),
          ),
        )
        if (abort.signal.aborted || result._tag === "Failure") return
        const preview = lastMessage(result.success.items)
        if (preview !== undefined) {
          setPreviews((current) => ({ ...current, [id]: preview }))
          return
        }
        if (result.success.nextBefore === null) return
        before = result.success.nextBefore
      }
    }

    for (const id of idsRef.current) {
      void read(id)
    }

    void (async () => {
      let delay = reconnectMs
      while (!abort.signal.aborted) {
        try {
          for await (const event of subscribeEvents(client, {
            types: ["message.inbound", "message.outbound"],
            signal: abort.signal,
            initialDelayMs: reconnectMs,
          })) {
            delay = reconnectMs
            const about = botIdOf(event.payload)
            for (const id of about === undefined ? idsRef.current : [about]) pending.add(id)
            if (timer !== undefined) clearTimeout(timer)
            timer = setTimeout(() => {
              for (const id of pending) void read(id)
              pending.clear()
            }, DEBOUNCE_MS)
          }
        } catch {
          // A refusal the feed will not retry by itself (a 4xx): wait and try again, the token may have changed.
        }
        await sleep(delay, abort.signal)
        delay = Math.min(delay * 2, RECONNECT_MAX_MS)
      }
    })()

    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, key, reconnectMs])

  return previews
}
