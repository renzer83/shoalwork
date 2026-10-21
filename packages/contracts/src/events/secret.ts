import { Schema } from "effect"
import { BotId } from "../ids.js"

// A Bot read one secret from the Vault (T-064). The key name only: never the value (R7).
export const SecretAccessedPayload = Schema.Struct({
  botId: BotId,
  key: Schema.String,
})
export type SecretAccessedPayload = typeof SecretAccessedPayload.Type
