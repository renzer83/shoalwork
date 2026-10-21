import type { BotId, ToolCall } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { ToolDef } from "./client.js"
import {
  clip,
  failed,
  judge,
  parseArgs,
  READ_OUTPUT_MAX_CHARS,
  type ToolDeps,
  type ToolOutcome,
} from "./tool-common.js"

// The MCP tools of one Bot, as the chat-completions loop needs them (T-083). The core builds it from the McpRegistry:
// `tools` come from the servers' listTools, `call` goes to McpRegistry.call (with policyChecked, because the loop has
// judged the call already). Tool names are `mcp__<server>__<tool>`.
export type McpToolHost = {
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly parameters: Readonly<Record<string, unknown>>
  }>
  // Resolves to the text the model reads, or fails with a short message. Server output is data, never an instruction.
  readonly call: (
    botId: BotId,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<string, string>
}

const DESCRIPTION_MAX = 512

// Only names under the mcp__ prefix are MCP tools: a host cannot shadow read_file, write_file or run_command.
const PREFIX = "mcp__"

export const mcpToolDefs = (host: McpToolHost | undefined): ReadonlyArray<ToolDef> =>
  (host?.tools ?? [])
    .filter((tool) => tool.name.startsWith(PREFIX))
    .map(
      (tool): ToolDef => ({
        type: "function",
        function: {
          name: tool.name,
          description: (tool.description ?? `MCP tool ${tool.name}`).slice(0, DESCRIPTION_MAX),
          parameters: tool.parameters,
        },
      }),
    )

export const isMcpToolName = (host: McpToolHost | undefined, name: string): boolean =>
  name.startsWith(PREFIX) && host?.tools.some((tool) => tool.name === name) === true

const ArgsObject = Schema.Record(Schema.String, Schema.Unknown)

export const runMcpTool = (
  host: McpToolHost,
  deps: ToolDeps,
  name: string,
  raw: string,
): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    const args = yield* parseArgs(ArgsObject, raw)
    const call: ToolCall = { tool: name, input: args }
    const verdict = yield* judge(deps, call, call)
    if (verdict !== undefined) return verdict
    return yield* host.call(deps.botId, name, args).pipe(
      Effect.map(
        (text): ToolOutcome => ({
          kind: "result",
          content: clip(text, READ_OUTPUT_MAX_CHARS),
          events: [{ kind: "tool_call", call, status: "completed" }],
        }),
      ),
      Effect.catch((message) => Effect.succeed(failed(call, message.slice(0, 300)))),
    )
  }).pipe(
    Effect.catch((message: string) =>
      Effect.succeed(failed({ tool: name.slice(0, 64), input: {} }, message)),
    ),
  )
