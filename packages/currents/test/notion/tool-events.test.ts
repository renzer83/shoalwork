import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { briefToBlocks } from "../../src/notion/tools.js"
import { fail } from "./support.js"
import { BOT, DATA_SOURCE, PAGE, runTool, TestLayer, toolEvents } from "./tool-support.js"

describe("notion tools: policy and the tool_called event", () => {
  it.effect("runs a tool only when the policy allows it, and records the allowed call", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const { run, asked, sent } = runTool(
        "allow",
        "notion.page.get",
        { id: PAGE },
        {
          object: "page",
          id: PAGE,
          url: "https://www.notion.so/x",
          last_edited_time: "2026-10-21T10:00:00.000Z",
          properties: {},
        },
      )
      yield* run
      expect(asked).toEqual(["notion.page.get"])
      expect(sent).toHaveLength(1)
      expect(yield* toolEvents(sql)).toEqual([
        { tool: "notion.page.get", botId: BOT, decision: "allow", ok: true, pageId: PAGE },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("denies a tool without sending anything, and records the denial with no content", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const { run, sent } = runTool("deny", "notion.page.create", {
        dataSourceId: DATA_SOURCE,
        properties: { secret: "must-not-be-recorded" },
        children: [],
      })
      const error = yield* Effect.flip(run)
      expect(error.message).toBe("notion.page.create denied by policy")
      expect(sent).toHaveLength(0)
      const events = yield* toolEvents(sql)
      expect(events).toEqual([
        { tool: "notion.page.create", botId: BOT, decision: "deny", ok: false, dataSourceId: DATA_SOURCE },
      ])
      expect(JSON.stringify(events)).not.toContain("must-not-be-recorded")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("asks for approval, which this connector cannot give, so nothing is sent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const { run, sent } = runTool("ask", "notion.page.append", { id: PAGE, blocks: briefToBlocks("x") })
      const error = yield* Effect.flip(run)
      expect(error.message).toBe("notion.page.append needs approval")
      expect(sent).toHaveLength(0)
      expect(yield* toolEvents(sql)).toEqual([
        { tool: "notion.page.append", botId: BOT, decision: "ask", ok: false, pageId: PAGE },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records an allowed create with its data source and never its content or the answer", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const { run } = runTool(
        "allow",
        "notion.page.create",
        {
          dataSourceId: DATA_SOURCE,
          properties: {
            Ideia: { title: [{ type: "text", text: { content: "conteudo-secreto-da-pagina" } }] },
          },
          children: briefToBlocks("corpo-secreto-do-brief"),
        },
        { id: "new-page-id-0001", url: "https://www.notion.so/conteudo-secreto-da-url" },
      )
      yield* run
      const events = yield* toolEvents(sql)
      expect(events).toEqual([
        { tool: "notion.page.create", botId: BOT, decision: "allow", ok: true, dataSourceId: DATA_SOURCE },
      ])
      expect(JSON.stringify(events)).not.toContain("secreto")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records a write that Notion refused as ok false, with the page it named", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const blocks = briefToBlocks("x")
      const { run, sent } = runTool(
        "allow",
        "notion.page.append",
        { id: PAGE, blocks },
        {},
        // A refusal from Notion, not a schema error: the call reached the API and failed there.
        fail(500),
      )
      expect((yield* Effect.flip(run)).message).toBe("notion.page.append failed with HTTP 500")
      expect(sent).toHaveLength(1)
      expect(yield* toolEvents(sql)).toEqual([
        { tool: "notion.page.append", botId: BOT, decision: "allow", ok: false, pageId: PAGE },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records an allowed call that failed as ok false", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const { run } = runTool("allow", "notion.page.get", { id: "../users/me" })
      yield* Effect.flip(run)
      expect(yield* toolEvents(sql)).toEqual([
        { tool: "notion.page.get", botId: BOT, decision: "allow", ok: false },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )
})
