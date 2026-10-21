import { HttpError, sendMessage } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useState } from "react"
import { useApi } from "../api-context.js"

export interface SendMessage {
  readonly sending: boolean
  readonly error: string | undefined
  // Resolves true when the core accepted the message.
  readonly send: (text: string) => Promise<boolean>
}

const describe = (error: unknown): string => {
  if (error instanceof HttpError) {
    if (error.status === 0) return "Cannot reach the core"
    if (error.status === 404) return "That Bot does not exist"
    return `The core answered HTTP ${error.status}`
  }
  return "The core answered with an unexpected body"
}

export function useSendMessage(bot: string): SendMessage {
  const { client } = useApi()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (text.trim() === "") return false
      setSending(true)
      setError(undefined)
      const result = await Effect.runPromise(Effect.result(sendMessage(client, bot, text)))
      setSending(false)
      if (result._tag === "Failure") {
        setError(describe(result.failure))
        return false
      }
      return true
    },
    [client, bot],
  )

  return { sending, error, send }
}
