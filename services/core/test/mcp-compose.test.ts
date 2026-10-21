import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type BotId, NewBot, TaskId } from "@shoalwork/contracts"
import {
  McpRegistry,
  McpRegistryLive,
  type McpToolGate,
  TelegramError,
  type TelegramOutShape,
} from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { SecretNotFound, type VaultShape } from "@shoalwork/vault"
import { Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect, vi } from "vitest"
import { makeOAuthNotifier, vaultCipher, vaultSecrets } from "../src/mcp-compose.js"
import { makeBotMcp, makeMcpToolHosts } from "../src/mcp-run.js"

const FAKE_SERVER = fileURLToPath(
  new URL("../../../packages/currents/test/mcp/fake-server.mjs", import.meta.url),
)
// The fake stdio server starts a node process: the 5 s default is not enough on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 })

// Built at runtime so the secret scanner sees no literal.
const VALUE = ["vault", "value", "for", "mcp", "7"].join("-")

const bot = Schema.decodeUnknownSync(NewBot)({
  name: "mcp-bot",
  role: "test",
  instructions: "test bot",
  kind: "fixed",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 60, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "test" },
  memory: { scope: "global" },
})

const asked: Array<string> = []
const gate: McpToolGate = {
  evaluate: (_botId, call) =>
    Effect.sync(() => {
      asked.push(call.tool)
      return { effect: "allow", risk: "external" }
    }),
}

// A Vault that knows one key, like the real one answers for a Bot's own secret.
const fakeVault: VaultShape = {
  get: (botId: BotId, key) =>
    key === "FAKE_SECRET"
      ? Effect.succeed(Redacted.make(VALUE))
      : Effect.fail(new SecretNotFound({ botId, key })),
}
const TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000001")
const off = new TelegramError({ op: "disabled", message: "telegram is not running" })
const telegramOff: TelegramOutShape = {
  send: () => Effect.fail(off),
  sendRef: () => Effect.fail(off),
  editReplyMarkup: () => Effect.fail(off),
  typing: () => Effect.void,
  ensureTopic: () => Effect.fail(off),
  openPodTopic: () => Effect.fail(off),
  postToPodTopic: () => Effect.fail(off),
}

const Live = Layer.mergeAll(
  McpRegistryLive({
    secretsOf: (botId) => vaultSecrets(fakeVault)(botId),
    gate,
    timeoutMs: 20_000,
  }),
  BotRegistryLive,
).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))

const stdio = (name: string, command = process.execPath, envKeys: ReadonlyArray<string> = []) => ({
  name,
  transport: "stdio" as const,
  command,
  args: [FAKE_SERVER],
  envKeys,
})

const eventsOf = (type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly payload: string
    }>`SELECT payload FROM events WHERE type = ${type} ORDER BY position`
    return rows.map((row) => row.payload)
  })

describe("MCP composition of the core", () => {
  it.effect(
    "hands a Bot's server to a CLI run: tools listed, secret only in secretEnv, trace without values",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const stored = yield* (yield* BotRegistry).upsert(bot, "test")
        yield* registry.upsert(stdio("fake", process.execPath, ["FAKE_SECRET"]))
        yield* registry.allow(stored.id, "fake", ["echo"])
        const botMcp = makeBotMcp({ registry, vault: fakeVault, beacon: yield* Beacon })
        const grant = yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })
        expect(grant?.servers.map((s) => s.name)).toEqual(["fake"])
        // Known tools came from listTools: the ones the Bot may not call are denied to the CLI by name.
        expect(grant?.servers[0]?.knownTools).toEqual(expect.arrayContaining(["echo", "secret_len", "fail"]))
        // The executor's env gets the alias; the server's config maps it back to the name the server reads.
        expect(Object.keys(grant?.secretEnv ?? {})).toEqual(["MCP_SECRET_0"])
        expect(grant?.servers[0]?.envRefs).toEqual({ FAKE_SECRET: "MCP_SECRET_0" })
        expect(Redacted.value(grant?.secretEnv.MCP_SECRET_0 ?? Redacted.make(""))).toBe(VALUE)
        expect(JSON.stringify(grant?.servers)).not.toContain(VALUE)
        const trace = (yield* eventsOf("mcp.server_changed")).join("\n")
        expect(trace).toContain('"action":"attached"')
        expect(trace).not.toContain(VALUE)
      }).pipe(Effect.provide(Live)),
  )

  it.effect(
    "fails closed: a server that cannot list its tools is not handed over when the Bot has an explicit list",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const stored = yield* (yield* BotRegistry).upsert(bot, "test")
        yield* registry.upsert(stdio("broken", "/nonexistent/command-for-the-test"))
        yield* registry.allow(stored.id, "broken", ["echo"])
        const botMcp = makeBotMcp({ registry, vault: fakeVault, beacon: yield* Beacon })
        expect(yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })).toBeUndefined()
        expect((yield* eventsOf("mcp.server_changed")).join("\n")).toContain('"reason":"list_tools_failed"')
      }).pipe(Effect.provide(Live)),
  )

  it.effect("refuses a server whose Vault key is missing, with the reason and no value", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert(stdio("needs-key", process.execPath, ["OTHER_KEY"]))
      yield* registry.allow(stored.id, "needs-key", "*")
      const botMcp = makeBotMcp({ registry, vault: fakeVault, beacon: yield* Beacon })
      expect(yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })).toBeUndefined()
      expect((yield* eventsOf("mcp.server_changed")).join("\n")).toContain('"reason":"secret_missing"')
    }).pipe(Effect.provide(Live)),
  )

  it.effect(
    "offers the allowed tools to the chat-completions loop and calls them after the loop's own judgment",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpRegistry
        const stored = yield* (yield* BotRegistry).upsert(bot, "test")
        yield* registry.upsert(stdio("fake"))
        yield* registry.allow(stored.id, "fake", ["echo"])
        const host = yield* makeMcpToolHosts({ registry }).forBot(stored.id)
        expect(host?.tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo"])
        asked.length = 0
        const text = yield* host?.call(stored.id, "mcp__fake__echo", { text: "hi" }) ?? Effect.succeed("")
        expect(text).toBe("echo:hi")
        expect(asked).toEqual([])
        const denied = yield* Effect.flip(host?.call(stored.id, "mcp__fake__fail", {}) ?? Effect.succeed(""))
        expect(denied).toContain("PolicyDenied")
      }).pipe(Effect.provide(Live)),
  )

  it.effect("lists a server's tools once per task, however many runs the task makes", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert(stdio("fake"))
      yield* registry.allow(stored.id, "fake", ["echo"])
      let lists = 0
      const counting = {
        ...registry,
        test: (...args: Parameters<typeof registry.test>) => {
          lists += 1
          return registry.test(...args)
        },
      }
      const botMcp = makeBotMcp({ registry: counting, vault: fakeVault, beacon: yield* Beacon })
      yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })
      yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })
      expect(lists).toBe(1)
    }).pipe(Effect.provide(Live)),
  )

  it.live("a server that does not answer within the list timeout is left out", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert(stdio("slow"))
      yield* registry.allow(stored.id, "slow", ["echo"])
      const hanging = { ...registry, test: () => Effect.never }
      const botMcp = makeBotMcp({
        registry: hanging,
        vault: fakeVault,
        beacon: yield* Beacon,
        listTimeoutMs: 200,
      })
      expect(yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })).toBeUndefined()
      expect((yield* eventsOf("mcp.server_changed")).join("\n")).toContain('"reason":"list_tools_failed"')
    }).pipe(Effect.provide(Live)),
  )

  it.effect("without VAULT_KEY a server that needs OAuth is refused for that reason", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert({
        name: "remote",
        transport: "http",
        url: "https://mcp.example/mcp",
        auth: { kind: "oauth" },
      })
      yield* registry.allow(stored.id, "remote", "*")
      const botMcp = makeBotMcp({ registry, vault: fakeVault, beacon: yield* Beacon, oauthAvailable: false })
      expect(yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })).toBeUndefined()
      expect((yield* eventsOf("mcp.server_changed")).join("\n")).toContain('"reason":"oauth_unavailable"')
    }).pipe(Effect.provide(Live)),
  )

  it.effect("aliases the bearer token of a remote server to MCP_SECRET_<n>", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert({
        name: "remote",
        transport: "http",
        url: "https://mcp.example/mcp",
        auth: { kind: "bearer", tokenKey: "FAKE_SECRET" },
      })
      yield* registry.allow(stored.id, "remote", "*")
      const botMcp = makeBotMcp({ registry, vault: fakeVault, beacon: yield* Beacon })
      const grant = yield* botMcp.resolve(stored, { id: TASK, botId: stored.id })
      expect(grant?.servers[0]?.bearerEnv).toBe("MCP_SECRET_0")
      expect(Object.keys(grant?.secretEnv ?? {})).toEqual(["MCP_SECRET_0"])
    }).pipe(Effect.provide(Live)),
  )

  it("seals and opens with the Vault key, and a wrong key does not open it", () => {
    const sealed = vaultCipher("key-one").seal(VALUE)
    expect(sealed).not.toContain(VALUE)
    expect(vaultCipher("key-one").open(sealed)).toBe(VALUE)
    expect(() => vaultCipher("key-two").open(sealed)).toThrow()
  })

  it.effect("sends the authorization link to the app channel and keeps it out of the audit event", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const stored = yield* (yield* BotRegistry).upsert(bot, "test")
      yield* registry.upsert({
        name: "remote",
        transport: "http",
        url: "https://mcp.example/mcp",
        auth: { kind: "oauth" },
      })
      yield* registry.allow(stored.id, "remote", "*")
      const notifier = makeOAuthNotifier({
        sql: yield* SqlClient,
        beacon: yield* Beacon,
        telegram: telegramOff,
        telegramOn: false,
      })
      const link = "https://auth.example/authorize?state=abc"
      yield* notifier.notify({ server: "remote", authorizationUrl: link })
      const changed = (yield* eventsOf("mcp.server_changed")).join("\n")
      expect(changed).toContain('"action":"auth_requested"')
      expect(changed).not.toContain(link)
      expect((yield* eventsOf("message.outbound")).join("\n")).toContain(link)
    }).pipe(Effect.provide(Live)),
  )
})
