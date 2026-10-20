import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import * as z from "zod/v4"
import type { BridgeApi } from "./api.js"
import {
  APPROVAL_TIMEOUT_MS,
  type BridgeMode,
  type DecideOptions,
  decidePermission,
  WAIT_SLICE_MS,
} from "./decide.js"

export const SERVER_NAME = "permission-bridge"
export const TOOL_NAME = "approve"
// What `--permission-prompt-tool` names (mcp__<server>__<tool>).
export const PERMISSION_TOOL_REF = `mcp__${SERVER_NAME}__${TOOL_NAME}`

// Looser than the documented fields on purpose: extra keys from newer CLIs must not make the tool fail.
export const ApproveInput = z.looseObject({
  tool_name: z.string().min(1).max(256),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().max(256).optional(),
})

export interface BridgeServerOptions {
  readonly mode?: BridgeMode
  readonly approvalTimeoutMs?: number
  readonly waitSliceMs?: number
}

export const makePermissionBridgeServer = (api: BridgeApi, options: BridgeServerOptions = {}): McpServer => {
  const decideOptions: DecideOptions = {
    mode: options.mode ?? "inline",
    approvalTimeoutMs: options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
    waitSliceMs: options.waitSliceMs ?? WAIT_SLICE_MS,
  }
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Permission prompt tool: decides whether the CLI may run a tool call. Answers allow or deny as JSON text.",
      inputSchema: ApproveInput,
    },
    // The CLI's cancellation aborts the signal: the fiber is interrupted, so a late approval never reaches the
    // evaluate that spends it.
    (args, ctx): Promise<CallToolResult> =>
      Effect.runPromise(
        decidePermission(
          api,
          { tool_name: args.tool_name, input: args.input, tool_use_id: args.tool_use_id },
          decideOptions,
        ),
        { signal: ctx.mcpReq.signal },
      ).then(
        (verdict) => ({ content: [{ type: "text", text: JSON.stringify(verdict) }] }),
        () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ behavior: "deny", message: "Permission check was cancelled." }),
            },
          ],
        }),
      ),
  )
  return server
}
