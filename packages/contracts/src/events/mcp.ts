import { Schema } from "effect"
import { BotId } from "../ids.js"

// One call of an MCP tool by a Bot (T-083), recorded whether it ran or not. Server and tool names, the outcome and the
// duration only: never the arguments, the answer or a token (R7, R14). `decision` is the policy's verdict.
export const McpCalledPayload = Schema.Struct({
  botId: BotId,
  server: Schema.String,
  tool: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
  ok: Schema.Boolean,
  durationMs: Schema.Int,
})
export type McpCalledPayload = typeof McpCalledPayload.Type

// The registry changed: a server was added or updated, or a Bot's access to one was set. Names only.
export const McpServerChangedPayload = Schema.Struct({
  action: Schema.Literals(["upserted", "allowed"]),
  server: Schema.String,
  botId: Schema.optionalKey(BotId),
})
export type McpServerChangedPayload = typeof McpServerChangedPayload.Type
