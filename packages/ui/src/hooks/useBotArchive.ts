import { Effect } from "effect"
import { useCallback, useState } from "react"
import { useApi } from "../api-context.js"

export interface BotArchive {
  // True while the core is answering the archive.
  readonly pending: boolean
  // The last refusal of the core, with its HTTP status (0 when the core never answered).
  readonly failure: { readonly status: number } | null
  readonly run: () => void
}

const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

// Archive of one Bot. The new state arrives over bot.state_changed; `onDone` refreshes the ficha once the core accepted.
export function useBotArchive(botId: string, onDone: () => void): BotArchive {
  const { client } = useApi()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<BotArchive["failure"]>(null)

  const run = useCallback(() => {
    setPending(true)
    setFailure(null)
    void Effect.runPromise(Effect.result(client.bots.archive(botId))).then((result) => {
      setPending(false)
      if (result._tag === "Success") {
        onDone()
      } else {
        setFailure({ status: statusOf(result.failure) })
      }
    })
  }, [client, botId, onDone])

  return { pending, failure, run }
}
