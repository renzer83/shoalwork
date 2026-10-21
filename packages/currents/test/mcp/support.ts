import { fileURLToPath } from "node:url"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import type { PolicyDecision } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Redacted } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { McpRegistryOptions, McpToolGate } from "../../src/mcp/index.js"
import { McpRegistry, McpRegistryLive } from "../../src/mcp/index.js"
import { DEV_DEF } from "../support.js"

export const FAKE_SERVER = fileURLToPath(new URL("./fake-server.mjs", import.meta.url))
// Built at runtime so the secret scanner sees no literal.
export const FAKE_SECRET_VALUE = ["fake", "vault", "value", "123"].join("-")

export const stdioServer = (name: string, envKeys: ReadonlyArray<string> = []) => ({
  name,
  transport: "stdio" as const,
  command: process.execPath,
  args: [FAKE_SERVER],
  envKeys,
})

export const gateSaying = (effect: PolicyDecision["effect"]) => {
  const asked: Array<string> = []
  const gate: McpToolGate = {
    evaluate: (_botId, call) =>
      Effect.sync(() => {
        asked.push(call.tool)
        return { effect, risk: "external" }
      }),
  }
  return { gate, asked }
}

export const secretsFake =
  (values: Record<string, string>): McpRegistryOptions["secretsOf"] =>
  () => ({
    get: (key) => {
      const value = values[key]
      return value === undefined ? Effect.fail(new Error("missing")) : Effect.succeed(Redacted.make(value))
    },
  })

export const layerWith = (options: McpRegistryOptions) =>
  Layer.mergeAll(McpRegistryLive(options), BotRegistryLive).pipe(
    Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
  )

// A stored Bot: allow() checks that the Bot exists.
export const makeBot = Effect.gen(function* () {
  const bot = yield* (yield* BotRegistry).upsert(DEV_DEF, "test")
  return bot.id
})

export const eventsOf = (sql: SqlClient, type: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly payload: string
    }>`SELECT payload FROM events WHERE type = ${type} ORDER BY position`
    return rows.map((row): unknown => JSON.parse(row.payload))
  })

export { McpRegistry }
