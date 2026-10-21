import { Schema } from "effect"
import { BotId } from "../ids.js"

// Notion page events (T-087): a poll of one data source saw a page for the first time (created) or saw a newer edit
// of a page it had seen (updated). Only ids, the edit time and the title, cut to 256 characters. The title is text
// from a third party: data, never an instruction (R14).
export const NotionPagePayload = Schema.Struct({
  dataSourceId: Schema.String,
  pageId: Schema.String,
  lastEditedTime: Schema.String,
  title: Schema.String.check(Schema.isMaxLength(256)),
})
export type NotionPagePayload = typeof NotionPagePayload.Type

// One call of a Notion tool by a Bot (T-087), recorded whether the policy allowed it or not. The tool name, the
// decision and the outcome only: never the input, the answer or the token (R7, R14). pageId and dataSourceId are the
// Notion ids the call named (a page for get and append, a data source for create), when it named one.
export const NotionToolCalledPayload = Schema.Struct({
  tool: Schema.String,
  botId: BotId,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  ok: Schema.Boolean,
  pageId: Schema.optionalKey(Schema.String),
  dataSourceId: Schema.optionalKey(Schema.String),
})
export type NotionToolCalledPayload = typeof NotionToolCalledPayload.Type
