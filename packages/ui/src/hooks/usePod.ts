import { getPod, type PodDetail, subscribeEvents } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import { POD_LIVE_TYPES, reactTo } from "./pod-model.js"

const REFRESH_DEBOUNCE_MS = 300

export type PodLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly detail: PodDetail }
  | { readonly kind: "failed"; readonly status: number }

// HttpError carries the HTTP status (0 when the core never answered).
const failedStatus = (error: unknown): number =>
  error instanceof Object && "status" in error && typeof error.status === "number" ? error.status : 0

// One Pod: the snapshot from GET /pods/:id, then the live feed patches it in place or refetches it.
export function usePod(id: string): { readonly load: PodLoad; readonly reload: () => void } {
  const { client, ready } = useApi()
  const [load, setLoad] = useState<PodLoad>({ kind: "loading" })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    let current: PodDetail | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const fetchSnapshot = (): Promise<void> =>
      Effect.runPromise(Effect.result(getPod(client, id))).then((result) => {
        if (abort.signal.aborted) return
        if (result._tag === "Success") {
          current = result.success
          setLoad({ kind: "loaded", detail: result.success })
        } else {
          setLoad({ kind: "failed", status: failedStatus(result.failure) })
        }
      })

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        void fetchSnapshot()
      }, REFRESH_DEBOUNCE_MS)
    }

    void fetchSnapshot()
    void (async () => {
      try {
        for await (const event of subscribeEvents(client, { types: POD_LIVE_TYPES, signal: abort.signal })) {
          if (current === null) continue
          const reaction = reactTo(current, event)
          if (reaction.kind === "patched") {
            current = reaction.detail
            setLoad({ kind: "loaded", detail: reaction.detail })
          } else if (reaction.kind === "refresh") {
            schedule()
          }
        }
      } catch {
        // The feed stopped; the snapshot stays on screen and Refresh still works.
      }
    })()

    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, id, ready, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  return { load, reload }
}
