import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  eventsOf,
  FAKE_SECRET_VALUE,
  gateSaying,
  layerWith,
  McpRegistry,
  makeBot,
  STDIO_TEST_TIMEOUT_MS,
  secretsFake,
  stdioServer,
} from "./support.js"

const allowAll = gateSaying("allow")
const secrets = secretsFake({ FAKE_SECRET: FAKE_SECRET_VALUE })
const Live = layerWith({ secretsOf: secrets, gate: allowAll.gate })

const textOf = (result: unknown): string => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return ""
  const first: unknown = result.content[0]
  return typeof first === "object" && first !== null && "text" in first && typeof first.text === "string"
    ? first.text
    : ""
}

const okFlags = (events: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  events.map((event) => (typeof event === "object" && event !== null && "ok" in event ? event.ok : undefined))

describe("McpRegistry CRUD", () => {
  it.effect("stores a server, updates it by name and keeps its id", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const first = yield* registry.upsert(stdioServer("fake"))
      const second = yield* registry.upsert({ ...stdioServer("fake"), args: ["other.js"], enabled: false })
      expect(second.id).toBe(first.id)
      expect(second.enabled).toBe(false)
      const all = yield* registry.list()
      expect(all.map((server) => server.name)).toEqual(["fake"])
      expect(second.transport === "stdio" && second.args).toEqual(["other.js"])
    }).pipe(Effect.provide(Live)),
  )

  it.effect("rejects an invalid server and records mcp.server_changed for a valid one", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const bad = yield* Effect.flip(
        registry.upsert({ name: "bad_name", transport: "http", url: "nope", auth: { kind: "none" } }),
      )
      expect(bad).toBeInstanceOf(SchemaViolation)
      yield* registry.upsert({
        name: "remote",
        transport: "http",
        url: "https://mcp.example/mcp",
        auth: { kind: "none" },
      })
      const events = yield* eventsOf(yield* SqlClient, "mcp.server_changed")
      expect(events).toEqual([{ action: "upserted", server: "remote" }])
    }).pipe(Effect.provide(Live)),
  )

  it.effect("lists only the enabled servers a Bot was allowed, with its tools", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      const a = yield* registry.upsert(stdioServer("alpha"))
      yield* registry.upsert(stdioServer("beta"))
      yield* registry.upsert({ ...stdioServer("gamma"), enabled: false })
      yield* registry.allow(botId, a.id, ["echo"])
      yield* registry.allow(botId, "gamma", "*")
      const mine = yield* registry.forBot(botId)
      expect(mine.map((server) => [server.name, server.allowedTools])).toEqual([["alpha", ["echo"]]])
    }).pipe(Effect.provide(Live)),
  )

  it.effect("refuses to allow an unknown server", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      const unknownServer = yield* Effect.flip(registry.allow(botId, "nope", "*"))
      expect(unknownServer._tag).toBe("NotFound")
    }).pipe(Effect.provide(Live)),
  )
})

describe("McpRegistry over a stdio server", () => {
  it.live(
    "test connects and lists the tools of the fake server",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const server = yield* registry.upsert(stdioServer("fake"))
        const { tools } = yield* registry.test(server.id)
        expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "fail", "secret_len"])
        expect(tools.find((tool) => tool.name === "echo")?.description).toBe("Echoes the text.")
      }).pipe(Effect.provide(Live)),
    STDIO_TEST_TIMEOUT_MS,
  )

  it.live(
    "call runs an allowed tool and records the call without its arguments",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const botId = yield* makeBot
        yield* registry.upsert(stdioServer("fake"))
        yield* registry.allow(botId, "fake", ["echo"])
        const result = yield* registry.call(botId, "fake", "echo", { text: "hello-argument" })
        expect(textOf(result)).toBe("echo:hello-argument")
        const events = yield* eventsOf(yield* SqlClient, "mcp.called")
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ botId, server: "fake", tool: "echo", decision: "allow", ok: true })
        expect(JSON.stringify(events)).not.toContain("hello-argument")
      }).pipe(Effect.provide(Live)),
    STDIO_TEST_TIMEOUT_MS,
  )

  it.live("call is denied when the policy does not allow it, and the server is never reached", () => {
    const asking = gateSaying("ask")
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      yield* registry.allow(botId, "fake", "*")
      const error = yield* Effect.flip(registry.call(botId, "fake", "echo", { text: "x" }))
      expect(error._tag).toBe("PolicyDenied")
      expect(asking.asked).toEqual(["mcp__fake__echo"])
      const events = yield* eventsOf(yield* SqlClient, "mcp.called")
      expect(events[0]).toMatchObject({ decision: "ask", ok: false })
    }).pipe(Effect.provide(layerWith({ secretsOf: secrets, gate: asking.gate })))
  })

  it.live("call refuses a tool the Bot was not allowed, before asking the policy", () => {
    const gate = gateSaying("allow")
    return Effect.gen(function* () {
      const registry = yield* McpRegistry
      const botId = yield* makeBot
      yield* registry.upsert(stdioServer("fake"))
      yield* registry.allow(botId, "fake", ["echo"])
      const error = yield* Effect.flip(registry.call(botId, "fake", "secret_len", {}))
      expect(error._tag).toBe("PolicyDenied")
      const other = yield* Effect.flip(registry.call(botId, "nobody", "echo", {}))
      expect(other._tag).toBe("McpError")
      expect(gate.asked).toEqual([])
    }).pipe(Effect.provide(layerWith({ secretsOf: secrets, gate: gate.gate })))
  })

  it.live(
    "policyChecked skips the second evaluation but still enforces the Bot's tool list",
    () => {
      const gate = gateSaying("deny")
      return Effect.gen(function* () {
        const registry = yield* McpRegistry
        const botId = yield* makeBot
        yield* registry.upsert(stdioServer("fake"))
        yield* registry.allow(botId, "fake", ["echo"])
        const ok = yield* registry.call(botId, "fake", "echo", { text: "a" }, { policyChecked: true })
        expect(textOf(ok)).toBe("echo:a")
        const refused = yield* Effect.flip(registry.call(botId, "fake", "fail", {}, { policyChecked: true }))
        expect(refused._tag).toBe("PolicyDenied")
        expect(gate.asked).toEqual([])
      }).pipe(Effect.provide(layerWith({ secretsOf: secrets, gate: gate.gate })))
    },
    STDIO_TEST_TIMEOUT_MS,
  )

  it.live(
    "injects the Vault key as an env var of the server; a tool error is a result with ok false",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const botId = yield* makeBot
        yield* registry.upsert(stdioServer("fake", ["FAKE_SECRET"]))
        yield* registry.allow(botId, "fake", "*")
        const length = yield* registry.call(botId, "fake", "secret_len", {})
        expect(textOf(length)).toBe(String(FAKE_SECRET_VALUE.length))
        const failing = yield* registry.call(botId, "fake", "fail", {})
        expect(failing).toMatchObject({ isError: true })
        const events = yield* eventsOf(yield* SqlClient, "mcp.called")
        expect(okFlags(events)).toEqual([true, false])
        expect(JSON.stringify(events)).not.toContain(FAKE_SECRET_VALUE)
      }).pipe(Effect.provide(Live)),
    STDIO_TEST_TIMEOUT_MS,
  )

  it.live("a missing Vault key is a secret error that names no value", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const server = yield* registry.upsert(stdioServer("fake", ["NOT_IN_VAULT"]))
      const error = yield* Effect.flip(registry.test(server.id))
      expect(error).toMatchObject({ _tag: "McpError", reason: "secret" })
    }).pipe(Effect.provide(Live)),
  )
})
