import type { McpServerForBot } from "@shoalwork/currents"
import {
  claudeServerEntries,
  codexServerBlock,
  isInjectable,
  mcpDeniedTools,
  mcpEnvNames,
} from "@shoalwork/executors"
import { describe, expect, it } from "vitest"
import { mcpEnvSources, oauthEnvName, toMcpInject, toMcpInjects } from "../src/mcp-inject-adapter.js"

const base = { id: "mcp_1", enabled: true, createdAt: "2026-10-21T00:00:00.000Z" }
const files: McpServerForBot = {
  ...base,
  name: "files",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  envKeys: ["FILES_TOKEN"],
  allowedTools: ["read", "list"],
}
const bearer: McpServerForBot = {
  ...base,
  name: "remote-api",
  transport: "http",
  url: "https://mcp.example/mcp",
  auth: { kind: "bearer", tokenKey: "REMOTE_TOKEN" },
  allowedTools: "*",
}
const oauth: McpServerForBot = { ...bearer, name: "notes-app", auth: { kind: "oauth" } }
const open: McpServerForBot = { ...bearer, name: "public", auth: { kind: "none" } }

describe("McpServerForBot -> McpInject", () => {
  it("maps stdio env keys and keeps the Bot's tool list", () => {
    expect(toMcpInject(files)).toEqual({
      name: "files",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      envKeys: ["FILES_TOKEN"],
      allowedTools: ["read", "list"],
    })
  })

  it("names the bearer env var from the Vault key, from the OAuth server name, or none", () => {
    expect(toMcpInject(bearer)).toMatchObject({ transport: "http", bearerEnv: "REMOTE_TOKEN" })
    expect(toMcpInject(oauth)).toMatchObject({ bearerEnv: "MCP_OAUTH_NOTES_APP" })
    expect(oauthEnvName("notes-app")).toBe("MCP_OAUTH_NOTES_APP")
    expect(toMcpInject(open)?.bearerEnv).toBeUndefined()
  })

  it("leaves out a server whose list is empty, and passes knownTools on", () => {
    expect(toMcpInject({ ...files, allowedTools: [] })).toBeUndefined()
    expect(toMcpInjects([files, bearer], { files: ["read", "list", "write"] })).toHaveLength(2)
    expect(toMcpInject(files, ["read", "write"])).toMatchObject({ knownTools: ["read", "write"] })
  })

  it("produces servers the CLI config accepts, with the denials and env names derived from them", () => {
    const injects = toMcpInjects([files, bearer, oauth, open], { files: ["read", "list", "write"] })
    expect(injects.every(isInjectable)).toBe(true)
    expect(Object.keys(claudeServerEntries(injects))).toEqual(["files", "remote-api", "notes-app", "public"])
    expect(codexServerBlock(injects)).toContain('enabled_tools = ["read", "list"]')
    expect(mcpDeniedTools(injects)).toEqual(["mcp__files__write"])
    expect(mcpEnvNames(injects)).toEqual(["FILES_TOKEN", "REMOTE_TOKEN", "MCP_OAUTH_NOTES_APP"])
  })

  it("says where each env value comes from", () => {
    expect(mcpEnvSources([files, bearer, oauth, open, { ...files, allowedTools: [] }])).toEqual([
      { env: "FILES_TOKEN", vaultKey: "FILES_TOKEN" },
      { env: "REMOTE_TOKEN", vaultKey: "REMOTE_TOKEN" },
      { env: "MCP_OAUTH_NOTES_APP", oauthServer: "notes-app" },
    ])
  })
})
