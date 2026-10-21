import { Effect } from "effect"
import { useEffect, useState } from "react"
import { useApi } from "../api-context.js"

export interface BotRef {
  readonly id: string
  readonly name: string
}

// The Bots as the pickers need them: id and name, nothing live. Empty until the list answers.
export function useBotNames(): ReadonlyArray<BotRef> {
  const { client } = useApi()
  const [bots, setBots] = useState<ReadonlyArray<BotRef>>([])

  useEffect(() => {
    let cancelled = false
    void Effect.runPromise(Effect.result(client.bots.list())).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setBots(result.success.bots.map((bot) => ({ id: bot.id, name: bot.name })))
      }
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return bots
}
