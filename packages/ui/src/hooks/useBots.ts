import type { BotSummary } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useApi } from "../api-context.js"
import { type LiveBotState, useLiveBotStates } from "./useLiveBotStates.js"

// A row of the list: the snapshot merged with the live state, and the 24 h cost of the Bot.
export interface BotRow extends BotSummary {
  readonly taskId?: string
  readonly costUsd24h: number | undefined
}

export type BotsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<BotRow> }
  | { readonly kind: "failed"; readonly status: number }

interface Snapshot {
  readonly bots: ReadonlyArray<BotSummary>
  readonly costs: Readonly<Record<string, number>>
}

// HttpError carries the HTTP status (0 when the core never answered); anything else counts as no answer.
const failedStatus = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

export function useBots(): { readonly load: BotsLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [failure, setFailure] = useState<number | null>(null)
  const live = useLiveBotStates()

  const reload = useCallback(() => {
    setFailure(null)
    void Effect.runPromise(
      Effect.all({
        list: Effect.result(client.bots.list()),
        costs: Effect.result(client.costs({ by: "bot", since: "24h" })),
      }),
    ).then(({ list, costs }) => {
      if (list._tag === "Failure") {
        setFailure(failedStatus(list.failure))
        return
      }
      const usd: Record<string, number> = {}
      if (costs._tag === "Success") {
        for (const row of costs.success.rows) {
          usd[row.key] = row.usd
        }
      }
      setSnapshot({ bots: list.success.bots, costs: usd })
    })
  }, [client])

  useEffect(() => {
    reload()
  }, [reload])

  const load = useMemo<BotsLoad>(() => {
    if (failure !== null) {
      return { kind: "failed", status: failure }
    }
    if (snapshot === null) {
      return { kind: "loading" }
    }
    const rows = snapshot.bots.map((bot): BotRow => {
      const overlay: LiveBotState | undefined = live[bot.id]
      return {
        ...bot,
        state: overlay?.state ?? bot.state,
        ...(overlay?.taskId === undefined ? {} : { taskId: overlay.taskId }),
        costUsd24h: snapshot.costs[bot.id],
      }
    })
    return { kind: "loaded", rows }
  }, [failure, snapshot, live])

  return { load, reload }
}
