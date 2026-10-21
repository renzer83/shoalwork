import { execFileSync } from "node:child_process"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Builds the package into dist/ and runs the real stdio entrypoint against a local fake core.
const reefRoot = fileURLToPath(new URL("..", import.meta.url))
// Resolved through Node, so it works with a hoisted or a nested node_modules.
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
const entry = join(reefRoot, "dist", "mcp.js")
const TOKEN = "tok_stdio_secret"
const CHUNK_ID = "chk_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"

const authSeen: Array<string> = []
const pathsSeen: Array<string> = []

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  authSeen.push(req.headers.authorization ?? "")
  pathsSeen.push(req.url ?? "")
  res.setHeader("content-type", "application/json")
  if ((req.url ?? "").startsWith("/reef/search?")) {
    res.end(
      JSON.stringify([
        {
          id: CHUNK_ID,
          path: "src/mcp/config.ts",
          startLine: 1,
          endLine: 3,
          lang: "ts",
          symbols: ["alpha"],
          content: "export const alpha = 1",
          score: 0.9,
          embedding: "AAAA",
        },
      ]),
    )
    return
  }
  res.statusCode = 404
  res.end("{}")
}

let core: Server
let baseUrl = ""

beforeAll(async () => {
  execFileSync(process.execPath, [tsc, "-p", reefRoot], {
    stdio: "pipe",
  })
  core = createServer(handle)
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", () => resolve()))
  const address = core.address()
  if (address === null || typeof address === "string") throw new Error("fake core did not bind")
  baseUrl = `http://127.0.0.1:${address.port}`
}, 180_000)

afterAll(() => new Promise<void>((resolve) => core.close(() => resolve())))

describe("reef MCP over stdio", () => {
  it("serves the three tools, keeps stdout to JSON-RPC and sends the token from the environment", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--repo", "shoalwork", "--bot", "bot_stdio", "--api", baseUrl],
      env: { PATH: process.env.PATH ?? "", SHOALWORK_API_TOKEN: TOKEN },
      stderr: "pipe",
    })
    const errors: Array<Error> = []
    transport.onerror = (error) => {
      errors.push(error)
    }
    const stderrChunks: Array<string> = []
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"))
    })
    const client = new Client({ name: "stdio-test", version: "1.0.0" })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["read_chunk", "search_code", "search_memory"])

      const result = await client.callTool({ name: "search_code", arguments: { q: "alpha", k: 3 } })
      const first = result.content[0]
      const body: unknown = JSON.parse(first !== undefined && first.type === "text" ? first.text : "null")
      expect(body).toEqual([
        {
          id: CHUNK_ID,
          path: "src/mcp/config.ts",
          startLine: 1,
          endLine: 3,
          lang: "ts",
          symbols: ["alpha"],
          score: 0.9,
          snippet: "export const alpha = 1",
          truncated: false,
        },
      ])
      expect(authSeen).toContain(`Bearer ${TOKEN}`)
      expect(pathsSeen.some((path) => path.startsWith("/reef/search?repo=shoalwork&q=alpha&k=3"))).toBe(true)
      expect(errors).toEqual([])
      expect(stderrChunks.join("")).not.toContain(TOKEN)
    } finally {
      await client.close()
    }
  }, 120_000)

  it("answers an invalid query with a validation tool error and never reaches the core", async () => {
    const before = pathsSeen.length
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--repo", "shoalwork", "--bot", "bot_stdio", "--api", baseUrl],
      env: { PATH: process.env.PATH ?? "", SHOALWORK_API_TOKEN: TOKEN },
    })
    const client = new Client({ name: "stdio-test", version: "1.0.0" })
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: "search_code", arguments: { q: "" } })
      const first = result.content[0]
      expect(result.isError).toBe(true)
      expect(
        first !== undefined && first.type === "text" && first.text.startsWith("Input validation error"),
      ).toBe(true)
      expect(pathsSeen.length).toBe(before)
    } finally {
      await client.close()
    }
  }, 120_000)
})
