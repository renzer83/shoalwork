import type { Tide } from "@shoalwork/contracts"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import { type TideRun, TideRunList } from "../components/tides/tide-model.js"
import { failedStatus } from "./failure.js"

export type TidesLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<Tide> }
  | { readonly kind: "failed"; readonly status: number }

// Every Tide of every Bot (GET /tides).
export function useTides(): { readonly load: TidesLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<TidesLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    void Effect.runPromise(Effect.result(client.tides.list())).then((result) => {
      setLoad(
        result._tag === "Success"
          ? { kind: "loaded", rows: result.success.tides }
          : { kind: "failed", status: failedStatus(result.failure) },
      )
    })
  }, [client])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}

export interface RunRow extends TideRun {
  // The task's state now ("unknown" when the task cannot be read).
  readonly state: string
}

export type RunsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<RunRow> }
  | { readonly kind: "failed"; readonly status: number }

// The firings of one Tide, each with the state of the task it created (GET /tides/:id/runs, then GET /tasks/:id).
export function useTideRuns(tideId: string): { readonly load: RunsLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<RunsLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    setLoad({ kind: "loading" })
    void (async () => {
      const runs = await Effect.runPromise(
        Effect.result(client.get(`/tides/${encodeURIComponent(tideId)}/runs`, TideRunList)),
      )
      if (runs._tag === "Failure") {
        setLoad({ kind: "failed", status: failedStatus(runs.failure) })
        return
      }
      const rows = await Promise.all(
        runs.success.runs.map(async (run): Promise<RunRow> => {
          const task = await Effect.runPromise(Effect.result(client.tasks.get(run.taskId)))
          return { ...run, state: task._tag === "Success" ? task.success.state : "unknown" }
        }),
      )
      setLoad({ kind: "loaded", rows })
    })()
  }, [client, tideId])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}
