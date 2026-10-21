import { Effect } from "effect"
import { useCallback, useState } from "react"
import { useApi } from "../api-context.js"

export type ControlAction = "pause" | "resume"

export interface BotControl {
  // The action the core is answering, if any.
  readonly pending: ControlAction | null
  // The last action the core refused, with its HTTP status (0 when the core never answered).
  readonly failure: { readonly action: ControlAction; readonly status: number } | null
  readonly run: (action: ControlAction) => void
}

const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

// Pause and resume of one Bot. The new state arrives over bot.state_changed; `onDone` refreshes the ficha once the core
// has accepted the action.
export function useBotControl(botId: string, onDone: () => void): BotControl {
  const { client } = useApi()
  const [pending, setPending] = useState<ControlAction | null>(null)
  const [failure, setFailure] = useState<BotControl["failure"]>(null)

  const run = useCallback(
    (action: ControlAction) => {
      setPending(action)
      setFailure(null)
      const request = action === "pause" ? client.control.pause(botId) : client.control.resume(botId)
      void Effect.runPromise(Effect.result(request)).then((result) => {
        setPending(null)
        if (result._tag === "Success") {
          onDone()
        } else {
          setFailure({ action, status: statusOf(result.failure) })
        }
      })
    },
    [client, botId, onDone],
  )

  return { pending, failure, run }
}
