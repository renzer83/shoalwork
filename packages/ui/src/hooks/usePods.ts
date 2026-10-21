import { listPods, type PodSummary, subscribeEvents } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"

// Events that change a row of the list: a Pod opened or closed, a step starting or finishing, a cost.
const LIST_TYPES = ["pod.opened", "pod.closed", "task.state_changed", "usage.recorded"] as const
const REFRESH_DEBOUNCE_MS = 500

export type PodsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly pods: ReadonlyArray<PodSummary> }
  | { readonly kind: "failed"; readonly status: number }

const failedStatus = (error: unknown): number =>
  error instanceof Object && "status" in error && typeof error.status === "number" ? error.status : 0

// The Pods, newest first, refetched when the feed reports a change (debounced).
export function usePods(): { readonly load: PodsLoad; readonly reload: () => void } {
  const { client, ready } = useApi()
  const [load, setLoad] = useState<PodsLoad>({ kind: "loading" })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!ready) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const fetchList = (): Promise<void> =>
      Effect.runPromise(Effect.result(listPods(client))).then((result) => {
        if (abort.signal.aborted) return
        if (result._tag === "Success") {
          setLoad({ kind: "loaded", pods: result.success.pods })
        } else {
          setLoad({ kind: "failed", status: failedStatus(result.failure) })
        }
      })

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        void fetchList()
      }, REFRESH_DEBOUNCE_MS)
    }

    void fetchList()
    void (async () => {
      try {
        for await (const _event of subscribeEvents(client, { types: LIST_TYPES, signal: abort.signal })) {
          schedule()
        }
      } catch {
        // The feed stopped; Refresh still works.
      }
    })()

    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, ready, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  return { load, reload }
}
