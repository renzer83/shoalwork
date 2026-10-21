import { BeaconLive } from "@shoalwork/beacon"
import { BotId, type PolicyDecision } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { makeNotion, Notion } from "../../src/notion/client.js"
import { callNotionTool, type NotionToolName, type ToolGate } from "../../src/notion/tools.js"
import { fakeTransport, ok, type Reply } from "./support.js"

// Shared by the tool tests: the Beacon and the database come from the test layer, so the notion.tool_called event can
// be read back.
export const TestLayer = Layer.provideMerge(BeaconLive, withTempDb())
export const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
export const PAGE = "3b1f0c2e-1111-4a2b-9c3d-0000000000a1"
export const DATA_SOURCE = "ds-ideas-0001"

// A gate that answers the same decision for every call and records what it was asked.
export const gateSaying = (effect: PolicyDecision["effect"]) => {
  const asked: Array<string> = []
  const gate: ToolGate = {
    evaluate: (_botId, call) =>
      Effect.sync(() => {
        asked.push(call.tool)
        return { effect, risk: "external" }
      }),
  }
  return { gate, asked }
}

// One tool call against a fresh client (one request, so no rate wait).
export const runTool = (
  decision: PolicyDecision["effect"],
  name: NotionToolName,
  input: unknown,
  answer: unknown = {},
  reply: Reply = ok(answer),
) => {
  const { transport, sent } = fakeTransport(reply)
  const { gate, asked } = gateSaying(decision)
  return {
    sent,
    asked,
    run: callNotionTool(gate, BOT, name, input).pipe(Effect.provideService(Notion, makeNotion(transport))),
  }
}

export const toolEvents = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly payload: string }>`SELECT payload FROM events
      WHERE type = 'notion.tool_called' ORDER BY position`
    return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>)
  })
