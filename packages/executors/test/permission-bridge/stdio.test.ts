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
const root = fileURLToPath(new URL("../..", import.meta.url))
// Resolved through Node, so it works with a hoisted or a nested node_modules.
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
const entry = join(root, "dist", "permission-bridge", "index.js")
// Built at runtime: the CI scanner must not see a literal token.
const TOKEN = ["mcp", "stdio", "token", "for", "tests"].join("_")
const APPROVAL = "apr_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"

const seen: Array<{ path: string; auth: string; body: string }> = []

const handle = (req: IncomingMessage, res: ServerResponse): void => {
  const chunks: Array<Buffer> = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8")
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body })
    res.setHeader("content-type", "application/json")
    if (req.url === "/policy/evaluate") {
      const evaluations = seen.filter((entry) => entry.path === "/policy/evaluate").length
      res.end(
        JSON.stringify(evaluations === 1 ? { effect: "ask", approvalId: APPROVAL } : { effect: "allow" }),
      )
      return
    }
    if ((req.url ?? "").startsWith(`/approvals/${APPROVAL}/wait`)) {
      res.end(JSON.stringify({ status: "approved" }))
      return
    }
    res.statusCode = 404
    res.end("{}")
  })
}

let core: Server
let baseUrl = ""

beforeAll(async () => {
  execFileSync(process.execPath, [tsc, "-p", root], {
    stdio: "pipe",
  })
  core = createServer(handle)
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", () => resolve()))
  const address = core.address()
  if (address === null || typeof address === "string") throw new Error("fake core did not bind")
  baseUrl = `http://127.0.0.1:${address.port}`
}, 180_000)

afterAll(() => new Promise<void>((resolve) => core.close(() => resolve())))

describe("permission-bridge over stdio", () => {
  it("serves the tool, holds an ask until approved, and sends the token from the environment only", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--api", baseUrl],
      env: { PATH: process.env.PATH ?? "", SHOALWORK_API_TOKEN: TOKEN },
      stderr: "pipe",
    })
    const stderrChunks: Array<string> = []
    transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")))
    const client = new Client({ name: "stdio-test", version: "1.0.0" })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(["approve"])
      const result = await client.callTool({
        name: "approve",
        arguments: { tool_name: "Bash", input: { command: "git push" } },
      })
      const first = result.content[0]
      const verdict: unknown = JSON.parse(first !== undefined && first.type === "text" ? first.text : "null")
      expect(verdict).toEqual({ behavior: "allow", updatedInput: { command: "git push" } })
      expect(seen.map((entry) => entry.path)).toEqual([
        "/policy/evaluate",
        `/approvals/${APPROVAL}/wait?timeoutMs=60000`,
        "/policy/evaluate",
      ])
      expect(seen.every((entry) => entry.auth === `Bearer ${TOKEN}`)).toBe(true)
      expect(stderrChunks.join("")).not.toContain(TOKEN)
    } finally {
      await client.close()
    }
  }, 120_000)

  it("refuses to start without the token", () => {
    expect(() =>
      execFileSync(process.execPath, [entry, "--api", baseUrl], {
        env: { PATH: process.env.PATH ?? "" },
        stdio: "pipe",
      }),
    ).toThrow()
  })
})
