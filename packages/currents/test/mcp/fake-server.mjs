// Fake MCP server for the tests (stdio, SDK v2). Tools: echo, secret_len (reports the length of FAKE_SECRET, never the
// value), fail (tool-level error).
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

serveStdio(() => {
  const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    "echo",
    { description: "Echoes the text.", inputSchema: z.object({ text: z.string() }) },
    ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  )
  server.registerTool(
    "secret_len",
    { description: "Length of FAKE_SECRET.", inputSchema: z.object({}) },
    () => ({
      content: [{ type: "text", text: String((process.env.FAKE_SECRET ?? "").length) }],
    }),
  )
  server.registerTool("fail", { description: "Always fails.", inputSchema: z.object({}) }, () => ({
    content: [{ type: "text", text: "boom" }],
    isError: true,
  }))
  return server
})
