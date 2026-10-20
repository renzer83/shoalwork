import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import {
  ReadChunkInput,
  type ReefApiError,
  type ReefMcpDeps,
  readChunkTool,
  SearchCodeInput,
  SearchMemoryInput,
  searchCodeTool,
  searchMemoryTool,
} from "./tools.js"

export type { ReefMcpDeps } from "./tools.js"

// Tool results are JSON text. A failure is text too (never a stack): the model sees `error: ...` and can carry on.
const runTool = <A>(effect: Effect.Effect<A, ReefApiError>): Promise<CallToolResult> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] })),
      Effect.catch((error) =>
        Effect.succeed<CallToolResult>({
          content: [{ type: "text", text: `error: ${error.op} failed (${error.reason})` }],
          isError: true,
        }),
      ),
    ),
  )

export const makeReefMcpServer = (deps: ReefMcpDeps): McpServer => {
  const server = new McpServer({ name: "reef", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    "search_code",
    {
      description:
        "Search the indexed repository (hybrid text and vector). Returns path, lines, symbols and a snippet per hit.",
      inputSchema: SearchCodeInput,
    },
    (args) => runTool(searchCodeTool(deps, args)),
  )
  server.registerTool(
    "search_memory",
    {
      description:
        "Search the bot's memory (facts, decisions, episodes). Returns id, scope, kind and a snippet.",
      inputSchema: SearchMemoryInput,
    },
    (args) => runTool(searchMemoryTool(deps, args)),
  )
  server.registerTool(
    "read_chunk",
    {
      description: "Read one indexed chunk by id (an id returned by search_code).",
      inputSchema: ReadChunkInput,
    },
    (args) => runTool(readChunkTool(deps, args)),
  )
  return server
}
