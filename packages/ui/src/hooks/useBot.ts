import type { BotDetail } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useApi } from "../api-context.js"
import { useLiveBotStates } from "./useLiveBotStates.js"

export type BotLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly bot: BotDetail; readonly costUsd24h: number | undefined }
  | { readonly kind: "failed"; readonly status: number }

// The ficha of one Bot (by id or name), with its state kept live from the SSE feed.
export function useBot(idOrName: string): { readonly load: BotLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [detail, setDetail] = useState<BotDetail | null>(null)
  const [failure, setFailure] = useState<number | null>(null)
  const [costUsd24h, setCostUsd24h] = useState<number | undefined>(undefined)
  const live = useLiveBotStates()

  const reload = useCallback(() => {
    setFailure(null)
    void Effect.runPromise(
      Effect.all({
        bot: Effect.result(client.bots.get(idOrName)),
        costs: Effect.result(client.costs({ by: "bot", since: "24h" })),
      }),
    ).then(({ bot: result, costs }) => {
      if (result._tag === "Success") {
        setDetail(result.success.bot)
        if (costs._tag === "Success") {
          setCostUsd24h(costs.success.rows.find((row) => row.key === result.success.bot.id)?.usd)
        }
      } else {
        const error: unknown = result.failure
        setFailure(error instanceof Object && "status" in error ? Number(error.status) : 0)
      }
    })
  }, [client, idOrName])

  useEffect(() => {
    reload()
  }, [reload])

  const load = useMemo<BotLoad>(() => {
    if (failure !== null) {
      return { kind: "failed", status: failure }
    }
    if (detail === null) {
      return { kind: "loading" }
    }
    const overlay = live[detail.id]
    return {
      kind: "loaded",
      bot: overlay === undefined ? detail : { ...detail, state: overlay.state },
      costUsd24h,
    }
  }, [failure, detail, live, costUsd24h])

  return { load, reload }
}
