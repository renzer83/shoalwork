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

// The registry changed (a server was added or updated, a Bot's access to one was set), or a server was handed to a run
// or refused to it, or its authorization link went out. Names only, never a token, a link, a value or an argument.
// `attached`/`attach_refused` are the record of what a CLI run could call: the CLI's own MCP calls do not pass through
// the registry, so they have no `mcp.called` (R12); this is the per-run trace that stands in for it.
export const McpServerChangedPayload = Schema.Struct({
  action: Schema.Literals(["upserted", "allowed", "attached", "attach_refused", "auth_requested"]),
  server: Schema.String,
  botId: Schema.optionalKey(BotId),
  taskId: Schema.optionalKey(Schema.String),
  // The tools the run may call on the server ("*" = all of them); only on `attached`.
  tools: Schema.optionalKey(Schema.Array(Schema.String)),
  // Why the server was not handed over; only on `attach_refused`.
  reason: Schema.optionalKey(
    Schema.Literals([
      "list_tools_failed",
      "secret_missing",
      "auth_required",
      "oauth_unavailable",
      "not_injectable",
    ]),
  ),
})
export type McpServerChangedPayload = typeof McpServerChangedPayload.Type
