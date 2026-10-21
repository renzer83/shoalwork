import type { ReplayComparison, ReplayStarted } from "@shoalwork/api-client"
import { HttpError } from "@shoalwork/api-client"
import type { ReplayOverrides } from "@shoalwork/contracts"
import { Effect } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "../api-context.js"

export type ReplayLoad =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "loaded"; readonly replayId: string; readonly comparison: ReplayComparison }
  | { readonly kind: "failed"; readonly message: string }

export interface UseReplay {
  readonly load: ReplayLoad
  // Starts a replay of the task; the comparison appears as soon as the core has it, and `refresh` re-reads it.
  readonly start: (taskId: string, overrides?: typeof ReplayOverrides.Encoded) => void
  readonly refresh: () => void
  readonly close: () => void
}

const describeFailure = (error: unknown): string => {
  if (error instanceof HttpError) {
    if (error.status === 400)
      return "O replay foi recusado: a task ainda não terminou ou o override não é permitido"
    if (error.status === 404) return "A task não foi encontrada"
    if (error.status === 0) return "Não foi possível falar com o core"
    return `O core respondeu HTTP ${error.status}`
  }
  return "O core respondeu com um corpo inesperado"
}

// The replay of one task from the Farol (T-122): start it, then show both runs side by side.
export function useReplay(): UseReplay {
  const { client } = useApi()
  const [load, setLoad] = useState<ReplayLoad>({ kind: "idle" })
  const replayId = useRef<string | null>(null)
  const generation = useRef(0)

  const read = useCallback(
    (id: string, ticket: number) => {
      void Effect.runPromise(Effect.result(client.replay.compare(id))).then((result) => {
        if (generation.current !== ticket) return
        setLoad(
          result._tag === "Success"
            ? { kind: "loaded", replayId: id, comparison: result.success }
            : { kind: "failed", message: describeFailure(result.failure) },
        )
      })
    },
    [client],
  )

  const start = useCallback<UseReplay["start"]>(
    (taskId, overrides) => {
      generation.current += 1
      const ticket = generation.current
      replayId.current = null
      setLoad({ kind: "starting" })
      void Effect.runPromise(Effect.result(client.replay.start(taskId, overrides))).then((result) => {
        if (generation.current !== ticket) return
        if (result._tag === "Failure") {
          setLoad({ kind: "failed", message: describeFailure(result.failure) })
          return
        }
        const started: ReplayStarted = result.success
        replayId.current = started.replay.id
        read(started.replay.id, ticket)
      })
    },
    [client, read],
  )

  const refresh = useCallback(() => {
    if (replayId.current !== null) read(replayId.current, generation.current)
  }, [read])

  const close = useCallback(() => {
    generation.current += 1
    replayId.current = null
    setLoad({ kind: "idle" })
  }, [])

  useEffect(
    () => () => {
      generation.current += 1
    },
    [],
  )

  return { load, start, refresh, close }
}
