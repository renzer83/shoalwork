import type { MemoryHit } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "../api-context.js"

export type MemoryLoad =
  | { readonly kind: "searching" }
  | { readonly kind: "loaded"; readonly hits: ReadonlyArray<MemoryHit> }
  | { readonly kind: "failed"; readonly status: number }

const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

// The Bot's memory: its current items when there is no query, the search hits when there is one. The latest request wins.
export function useBotMemory(botId: string): {
  readonly load: MemoryLoad
  readonly search: (text: string) => void
  readonly forget: (memoryId: string) => void
} {
  const { client } = useApi()
  const [load, setLoad] = useState<MemoryLoad>({ kind: "searching" })
  const latest = useRef(0)
  const query = useRef<string | undefined>(undefined)

  const run = useCallback(
    (q: string | undefined) => {
      latest.current += 1
      const ticket = latest.current
      query.current = q
      setLoad({ kind: "searching" })
      const request =
        q === undefined ? client.memory.search({ bot: botId }) : client.memory.search({ bot: botId, q })
      void Effect.runPromise(Effect.result(request)).then((result) => {
        if (ticket !== latest.current) {
          return
        }
        setLoad(
          result._tag === "Success"
            ? { kind: "loaded", hits: result.success }
            : { kind: "failed", status: statusOf(result.failure) },
        )
      })
    },
    [client, botId],
  )

  useEffect(() => {
    run(undefined)
  }, [run])

  const search = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      run(trimmed === "" ? undefined : trimmed)
    },
    [run],
  )

  const forget = useCallback(
    (memoryId: string) => {
      void Effect.runPromise(Effect.result(client.memory.forget(memoryId))).then(() => run(query.current))
    },
    [client, run],
  )

  return { load, search, forget }
}
