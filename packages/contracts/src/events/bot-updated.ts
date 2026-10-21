import { Schema } from "effect"
import { BotId } from "../ids.js"

// Top-level Bot fields (and the two executor lists) whose change alters what a Bot may do or spend. Such a change is
// still allowed; the event marks it `sensitive` so the Farol can filter it.
export const SENSITIVE_BOT_FIELDS: ReadonlyArray<string> = ["policy", "executors.allowed", "tank", "budget"]

// A Bot definition edited through the API. `fields` names what changed; values stay in the Bot record, not the event.
export const BotUpdatedPayload = Schema.Struct({
  botId: BotId,
  fields: Schema.Array(Schema.String),
  by: Schema.String,
  sensitive: Schema.Boolean,
})
