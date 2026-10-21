import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  McpServer,
  NewMcpServer,
  parseQualifiedToolName,
  qualifiedToolName,
  toolAllowed,
} from "../../src/mcp/index.js"

const stdio = {
  name: "files",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  envKeys: ["API_KEY"],
}
const http = {
  name: "remote",
  transport: "http",
  url: "https://mcp.example/mcp",
  auth: { kind: "bearer", tokenKey: "TOKEN" },
}

describe("MCP server schemas", () => {
  it("round-trips a stdio and an http server", () => {
    for (const raw of [stdio, http]) {
      const decoded = Schema.decodeUnknownSync(NewMcpServer)(raw)
      expect(Schema.encodeSync(NewMcpServer)(decoded)).toEqual(raw)
    }
    const stored = { ...http, id: "mcp_1", enabled: true, createdAt: "2026-10-21T00:00:00.000Z" }
    expect(Schema.encodeSync(McpServer)(Schema.decodeUnknownSync(McpServer)(stored))).toEqual(stored)
  })

  it("rejects names that would break a tool name, bad env keys, a missing command and a non-http url", () => {
    const reject = (raw: unknown) => expect(() => Schema.decodeUnknownSync(NewMcpServer)(raw)).toThrow()
    reject({ ...stdio, name: "has_underscore" })
    reject({ ...stdio, name: "has space" })
    reject({ ...stdio, envKeys: ["lower"] })
    reject({ ...stdio, command: "" })
    reject({ ...http, url: "file:///etc/passwd" })
    reject({ ...http, auth: { kind: "bearer" } })
  })
})

describe("MCP tool names", () => {
  it("qualifies and splits a tool name, keeping a tool that holds double underscores whole", () => {
    expect(qualifiedToolName("github", "search_issues")).toBe("mcp__github__search_issues")
    expect(parseQualifiedToolName("mcp__github__search_issues")).toEqual({
      server: "github",
      tool: "search_issues",
    })
    expect(parseQualifiedToolName("mcp__a__b__c")).toEqual({ server: "a", tool: "b__c" })
    expect(parseQualifiedToolName("read_file")).toBeUndefined()
    expect(parseQualifiedToolName("mcp__nocut")).toBeUndefined()
  })

  it("allows every tool for * and only the listed ones otherwise", () => {
    expect(toolAllowed("*", "x")).toBe(true)
    expect(toolAllowed(["a"], "a")).toBe(true)
    expect(toolAllowed(["a"], "b")).toBe(false)
  })
})
