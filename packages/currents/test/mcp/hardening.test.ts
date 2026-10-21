import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { capResult } from "../../src/mcp/client.js"
import {
  AllowedTools,
  isAllowedServerUrl,
  MCP_RESULT_MAX_CHARS,
  makeMcpRegistry,
  NewMcpServer,
} from "../../src/mcp/index.js"
import { eventsOf, gateSaying, layerWith, McpRegistry, makeBot, secretsFake, stdioServer } from "./support.js"

const secrets = secretsFake({})
const Live = layerWith({ secretsOf: secrets, gate: gateSaying("allow").gate })

describe("tool list validation", () => {
  it("accepts * and plain names, rejects a name that smuggles a second tool", () => {
    const decode = Schema.decodeUnknownSync(AllowedTools)
    expect(decode("*")).toBe("*")
    expect(decode(["search", "read.file-2"])).toEqual(["search", "read.file-2"])
    for (const bad of ["x,Bash", "Bash(git push)", "a b", "", "a".repeat(65)])
      expect(() => decode([bad])).toThrow()
  })

  it.effect("registry.allow refuses an injected tool name and stores nothing", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      const error = yield* Effect.flip(registry.allow(botId, "fake", ["echo", "x,Bash"]))
      expect(error._tag).toBe("SchemaViolation")
      expect(yield* registry.forBot(botId)).toEqual([])
    }).pipe(Effect.provide(Live)),
  )
})

describe("server schema hardening", () => {
  const http = (url: string) => ({ name: "remote", transport: "http", url, auth: { kind: "none" } })
  const ok = (raw: unknown) => Schema.decodeUnknownSync(NewMcpServer)(raw)

  it("requires https, with http only for the local machine", () => {
    expect(ok(http("https://mcp.example/mcp"))).toBeDefined()
    expect(ok(http("http://localhost:8080/mcp"))).toBeDefined()
    expect(ok(http("http://127.0.0.1:8080/mcp"))).toBeDefined()
    expect(ok(http("http://[::1]:8080/mcp"))).toBeDefined()
    expect(() => ok(http("http://mcp.example/mcp"))).toThrow()
  })

  it("blocks link-local and metadata addresses and credentials in the url", () => {
    for (const url of [
      "https://169.254.169.254/latest",
      "http://169.254.169.254/",
      "https://[fe80::1]/mcp",
      "https://metadata.google.internal/",
      "https://user:pw@mcp.example/",
    ])
      expect(isAllowedServerUrl(url)).toBe(false)
  })

  it("rejects the names of the product's own servers", () => {
    for (const name of ["reef", "Reef", "permission-bridge"])
      expect(() => ok({ ...stdioServer(name), name })).toThrow()
  })
})

describe("call hardening", () => {
  it.live("arguments that are not an object are an error and the server is never started", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      yield* registry.allow(botId, "fake", "*")
      for (const bad of ["text", 7, null, [1, 2]]) {
        const error = yield* Effect.flip(registry.call(botId, "fake", "echo", bad))
        expect(error).toMatchObject({
          _tag: "McpError",
          reason: "call",
          message: "tool arguments must be an object",
        })
      }
      expect(yield* eventsOf(yield* SqlClient, "mcp.called")).toEqual([])
    }).pipe(Effect.provide(Live)),
  )

  it.live("the tool name in the event is cut to 64 characters", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      yield* registry.allow(botId, "fake", ["echo"])
      yield* Effect.flip(registry.call(botId, "fake", "z".repeat(300), {}))
      const events = yield* eventsOf(yield* SqlClient, "mcp.called")
      expect(JSON.stringify(events)).not.toContain("z".repeat(65))
      expect(events[0]).toMatchObject({ tool: "z".repeat(64), decision: "deny" })
    }).pipe(Effect.provide(Live)),
  )

  it.live("an event that cannot be appended is logged and the call still returns its result", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const real = yield* Beacon
      const registry = makeMcpRegistry(
        sql,
        { ...real, append: () => Effect.die(new Error("beacon down")) },
        { secretsOf: secrets, gate: gateSaying("allow").gate },
      )
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      yield* registry.allow(botId, "fake", "*")
      const result = yield* registry.call(botId, "fake", "echo", { text: "still-here" })
      expect(JSON.stringify(result)).toContain("echo:still-here")
    }).pipe(Effect.provide(Live)),
  )
})

describe("result cap", () => {
  it("keeps a short answer as it is and cuts a long one with a notice", () => {
    const short = { content: [{ type: "text", text: "hi" }] }
    expect(capResult(short)).toBe(short)
    const long = {
      content: [
        { type: "text", text: "a".repeat(MCP_RESULT_MAX_CHARS + 10) },
        { type: "text", text: "later" },
      ],
    }
    const cut = JSON.stringify(capResult(long))
    expect(cut).toContain("[truncated")
    expect(cut).not.toContain("later")
    expect(cut.length).toBeLessThan(MCP_RESULT_MAX_CHARS + 500)
  })

  it("spends the budget across blocks in order", () => {
    const two = {
      content: [
        { type: "text", text: "abcd" },
        { type: "text", text: "efgh" },
      ],
    }
    expect(JSON.stringify(capResult(two, 6))).toContain('"text":"ef\\n[truncated')
    expect(capResult("plain")).toBe("plain")
  })
})
