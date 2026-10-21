import { it } from "@effect/vitest"
import { BotId } from "@shoalwork/contracts"
import { Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { claudeMcpJson, type McpAttachment } from "../src/mcp-config.js"
import { codexServerBlock, isInjectable, type McpInject, mcpEnvNames } from "../src/mcp-inject.js"
import { hostFromContext, McpToolHosts } from "../src/openai-compat/mcp-tools.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_11111111-2222-3333-4444-555555555555")
const attachment: McpAttachment = {
  serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js",
  repo: "none",
  bot: "bot_x",
  api: "http://127.0.0.1:28900",
  reef: "off",
  servers: [
    {
      name: "notes",
      transport: "stdio",
      command: "node",
      args: ["s.js"],
      envKeys: ["NOTES_TOKEN"],
      allowedTools: "*",
    },
  ],
}

describe("a run without the reef server", () => {
  it("writes the Bot's servers and leaves the reef entry out, with env names only", () => {
    const doc = claudeMcpJson(attachment)
    const servers = Object.keys(
      Schema.decodeUnknownSync(Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }))(
        JSON.parse(doc),
      ).mcpServers,
    )
    expect(servers).toEqual(["notes"])
    expect(doc).toContain(`\${NOTES_TOKEN}`)
  })

  it("keeps the reef entry when the run has the index", () => {
    const { reef: _off, ...withReef } = attachment
    expect(claudeMcpJson(withReef)).toContain('"reef"')
  })
})

describe("MCP tools of an openai-compat run", () => {
  it.effect("are read from the context when the instance has no resolver of its own", () =>
    Effect.gen(function* () {
      const host = yield* hostFromContext(BOT)
      expect(host?.tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo"])
    }).pipe(
      Effect.provide(
        Layer.succeed(McpToolHosts, {
          forBot: () =>
            Effect.succeed({
              tools: [{ name: "mcp__fake__echo", parameters: { type: "object" } }],
              call: () => Effect.succeed("ok"),
            }),
        }),
      ),
    ),
  )

  it.effect("are absent when the core provides none", () =>
    Effect.gen(function* () {
      expect(yield* hostFromContext(BOT)).toBeUndefined()
    }),
  )
})

const aliased: McpInject = {
  name: "notes",
  transport: "stdio",
  command: "node",
  args: ["s.js", "--flag"],
  envKeys: ["NOTES_TOKEN", "OTHER_KEY"],
  envRefs: { NOTES_TOKEN: "MCP_SECRET_0", OTHER_KEY: "MCP_SECRET_1" },
  allowedTools: "*",
}

describe("secrets aliased to MCP_SECRET_<n>", () => {
  it("Claude Code maps the alias back to the name the server reads", () => {
    const doc = claudeMcpJson({ ...attachment, servers: [aliased] })
    expect(doc).toContain(`"NOTES_TOKEN": "\${MCP_SECRET_0}"`)
    expect(doc).toContain(`"OTHER_KEY": "\${MCP_SECRET_1}"`)
  })

  it("Codex passes the aliases through and renames them in a fixed sh -c script", () => {
    const block = codexServerBlock([aliased])
    expect(block).toContain('command = "sh"')
    expect(block).toContain('env_vars = ["MCP_SECRET_0", "MCP_SECRET_1"]')
    // The script holds env names only; the server's command and args are positional.
    expect(block).toContain(
      'NOTES_TOKEN=\\"$MCP_SECRET_0\\" OTHER_KEY=\\"$MCP_SECRET_1\\" exec \\"$0\\" \\"$@\\"',
    )
    expect(block).toContain('"node", "s.js", "--flag"')
  })

  it("the run carries the aliases, and an alias outside the shape is not injectable", () => {
    expect(mcpEnvNames([aliased])).toEqual(["MCP_SECRET_0", "MCP_SECRET_1"])
    expect(isInjectable({ ...aliased, envRefs: { NOTES_TOKEN: "PATH" } })).toBe(false)
    expect(isInjectable({ ...aliased, envRefs: { UNKNOWN_KEY: "MCP_SECRET_0" } })).toBe(false)
  })
})
