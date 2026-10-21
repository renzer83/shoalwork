import { subscribeEvents } from "@shoalwork/api-client"
import { BotState } from "@shoalwork/contracts"
import { Option, Schema } from "effect"
import { useEffect, useState } from "react"
import { useApi } from "../api-context.js"

// The payload of bot.state_changed as the core writes it (contracts keep this payload private to the core).
const StateChangedPayload = Schema.Struct({
  botId: Schema.String,
  to: BotState,
  taskId: Schema.optional(Schema.String),
})

export interface LiveBotState {
  readonly state: BotState
  readonly taskId?: string
}

// Latest state per bot id, fed by the SSE feed of bot.state_changed. Starts empty: the list overlays it on the snapshot.
export function useLiveBotStates(): Readonly<Record<string, LiveBotState>> {
  const { client } = useApi()
  const [live, setLive] = useState<Readonly<Record<string, LiveBotState>>>({})

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      for await (const event of subscribeEvents(client, {
        types: ["bot.state_changed"],
        signal: controller.signal,
      })) {
        const change = Option.getOrUndefined(Schema.decodeUnknownOption(StateChangedPayload)(event.payload))
        if (change !== undefined) {
          const next: LiveBotState =
            change.taskId === undefined ? { state: change.to } : { state: change.to, taskId: change.taskId }
          setLive((previous) => ({ ...previous, [change.botId]: next }))
        }
      }
    })().catch(() => undefined)
    return () => controller.abort()
  }, [client])

  return live
}
