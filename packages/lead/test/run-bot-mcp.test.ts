import { it } from "@effect/vitest"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { ExecutorId, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import type { BotMcpShape } from "../src/bot-mcp.js"
import { makeMcpTokens } from "../src/index.js"
import { makeWithMcp } from "../src/run-mcp.js"
import { NEW_BOT, specFor } from "./support.js"

const SERVER = { serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js", api: "http://127.0.0.1:28900" }
const VALUE = ["bot", "mcp", "secret", "9"].join("-")
const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const GEMINI = Schema.decodeUnknownSync(ExecutorId)("gemini")
const TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000009")
const Live = Layer.mergeAll(BotRegistryLive).pipe(
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)

const botMcp: BotMcpShape = {
  resolve: () =>
    Effect.succeed({
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
      secretEnv: { NOTES_TOKEN: Redacted.make(VALUE) },
    }),
}

describe("the Bot's own MCP servers in a run", () => {
  it.effect("a run with no repo still gets them, without the reef server", () =>
    Effect.gen(function* () {
      const bot = yield* (yield* BotRegistry).upsert(NEW_BOT, "test")
      const sql = yield* SqlClient
      const withMcp = makeWithMcp({
        sql,
        tokens: makeMcpTokens(sql),
        mcp: SERVER,
        botMcp,
        raiseError: () => Effect.void,
        report: () => Effect.void,
        revokeTask: () => Effect.void,
      })
      const spec = { ...specFor(bot), id: TASK }
      const grant = yield* withMcp(spec, bot, CLAUDE, 60_000, (g) => Effect.succeed(g))
      expect(grant?.attachment.reef).toBe("off")
      expect(grant?.attachment.servers?.map((s) => s.name)).toEqual(["notes"])
      expect(grant?.extraEnv).toEqual({})
      expect(Redacted.value(grant?.secretEnv?.NOTES_TOKEN ?? Redacted.make(""))).toBe(VALUE)
      expect(JSON.stringify(grant?.attachment)).not.toContain(VALUE)
    }).pipe(Effect.provide(Live)),
  )

  it.effect("without a reef server configured the Bot's own servers still reach the run", () =>
    Effect.gen(function* () {
      const bot = yield* (yield* BotRegistry).upsert(NEW_BOT, "test")
      const sql = yield* SqlClient
      const withMcp = makeWithMcp({
        sql,
        tokens: makeMcpTokens(sql),
        mcp: undefined,
        botMcp,
        raiseError: () => Effect.void,
        report: () => Effect.void,
        revokeTask: () => Effect.void,
      })
      const grant = yield* withMcp({ ...specFor(bot), id: TASK }, bot, CLAUDE, 60_000, (g) =>
        Effect.succeed(g),
      )
      expect(grant?.attachment.reef).toBe("off")
      expect(grant?.attachment.servers?.map((server) => server.name)).toEqual(["notes"])
      expect(Object.keys(grant?.secretEnv ?? {})).toEqual(["NOTES_TOKEN"])
    }).pipe(Effect.provide(Live)),
  )

  it.effect("an executor that takes no MCP config gets nothing", () =>
    Effect.gen(function* () {
      const bot = yield* (yield* BotRegistry).upsert(NEW_BOT, "test")
      const sql = yield* SqlClient
      const withMcp = makeWithMcp({
        sql,
        tokens: makeMcpTokens(sql),
        mcp: SERVER,
        botMcp,
        raiseError: () => Effect.void,
        report: () => Effect.void,
        revokeTask: () => Effect.void,
      })
      const grant = yield* withMcp({ ...specFor(bot), id: TASK }, bot, GEMINI, 60_000, (g) =>
        Effect.succeed(g),
      )
      expect(grant).toBeUndefined()
    }).pipe(Effect.provide(Live)),
  )
})
