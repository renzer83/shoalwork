import type { MemoryHit } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "../api-context.js"

export type MemoryLoad =
  | { readonly kind: "searching" }
  | { readonly kind: "loaded"; readonly hits: ReadonlyArray<MemoryHit> }
  | { readonly kind: "failed"; readonly status: number }

// Outcome of an edit: the core superseded the item, or it refused (status 0 when it never answered).
export type MemoryEdit = { readonly ok: true } | { readonly ok: false; readonly status: number }

const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

// The Bot's memory: its current items when there is no query, the search hits when there is one. The latest request wins.
export function useBotMemory(botId: string): {
  readonly load: MemoryLoad
  readonly search: (text: string) => void
  readonly forget: (memoryId: string) => void
  readonly edit: (memoryId: string, content: string) => Promise<MemoryEdit>
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

  // PATCH /memory/:id gives the item a new id (the old one is superseded), so the list is read again afterwards.
  const edit = useCallback(
    (memoryId: string, content: string): Promise<MemoryEdit> =>
      Effect.runPromise(Effect.result(client.memory.edit(memoryId, content))).then((result): MemoryEdit => {
        if (result._tag === "Failure") {
          return { ok: false, status: statusOf(result.failure) }
        }
        run(query.current)
        return { ok: true }
      }),
    [client, run],
  )

  return { load, search, forget, edit }
}
