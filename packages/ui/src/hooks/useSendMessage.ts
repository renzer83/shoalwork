import { HttpError, sendMessage } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useState } from "react"
import { useApi } from "../api-context.js"
import { type Translate, useLocale } from "../i18n/index.js"

export interface SendMessage {
  readonly sending: boolean
  readonly error: string | undefined
  // Resolves true when the core accepted the message.
  readonly send: (text: string) => Promise<boolean>
}

const describe = (error: unknown, t: Translate): string => {
  if (error instanceof HttpError) {
    if (error.status === 0) return t("common.cannotReach")
    if (error.status === 404) return t("chat.noBot")
    return t("common.httpAnswered", { status: error.status })
  }
  return t("common.unexpectedBody")
}

export function useSendMessage(bot: string): SendMessage {
  const { client } = useApi()
  const { t } = useLocale()
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
        setError(describe(result.failure, t))
        return false
      }
      return true
    },
    [client, bot, t],
  )

  return { sending, error, send }
}
