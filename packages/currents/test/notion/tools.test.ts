import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { NotionError } from "../../src/notion/client.js"
import { notionConnector } from "../../src/notion/connector.js"
import {
  BLOCKS_PER_REQUEST,
  briefToBlocks,
  NOTION_TOOLS,
  RICH_TEXT_MAX,
  splitBrief,
} from "../../src/notion/tools.js"
import { fixture } from "./support.js"
import { DATA_SOURCE, PAGE, runTool, TestLayer } from "./tool-support.js"

describe("notion brief splitting", () => {
  it("keeps a short brief in one paragraph block", () => {
    expect(briefToBlocks("Brief curto.")).toEqual([
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "Brief curto." } }] },
      },
    ])
  })

  it("breaks a brief longer than 2000 units into blocks that each fit, keeping every line", () => {
    const line = "palavra ".repeat(60)
    const brief = Array.from({ length: 30 }, () => line).join("\n")
    expect(brief.length).toBeGreaterThan(RICH_TEXT_MAX)
    const pieces = splitBrief(brief)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(RICH_TEXT_MAX)
    const lines = pieces.flatMap((piece) => piece.split("\n")).filter((text) => text !== "")
    expect(lines).toEqual(brief.split("\n"))
  })

  it("cuts one line longer than 2000 units without losing a character", () => {
    const brief = "x".repeat(4500)
    const blocks = briefToBlocks(brief)
    expect(blocks.map((block) => block.paragraph.rich_text[0]?.text.content.length)).toEqual([
      2000, 2000, 500,
    ])
    expect(blocks.map((block) => block.paragraph.rich_text[0]?.text.content).join("")).toBe(brief)
  })

  it("never cuts a surrogate pair in two", () => {
    const brief = "\u{1F4A1}".repeat(1200)
    for (const piece of splitBrief(brief)) {
      expect(piece.length).toBeLessThanOrEqual(RICH_TEXT_MAX)
      expect(Array.from(piece).join("")).toBe(piece)
    }
  })
})

describe("notion tools: input schemas", () => {
  it.effect("refuses an append with more blocks than one request carries", () =>
    Effect.gen(function* () {
      const block = briefToBlocks("a")[0]
      if (block === undefined) throw new Error("expected one block")
      const { run, sent } = runTool("allow", "notion.page.append", {
        id: PAGE,
        blocks: Array.from({ length: BLOCKS_PER_REQUEST + 1 }, () => block),
      })
      const error = yield* Effect.flip(run)
      expect(error).toBeInstanceOf(NotionError)
      expect(error.message).toBe("notion.page.append input does not match its schema")
      expect(sent).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("refuses a rich text item over 2000 units and an id with path characters", () =>
    Effect.gen(function* () {
      const tooLong = {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "y".repeat(RICH_TEXT_MAX + 1) } }] },
      }
      const longRun = runTool("allow", "notion.page.append", { id: PAGE, blocks: [tooLong] })
      expect((yield* Effect.flip(longRun.run)).message).toBe(
        "notion.page.append input does not match its schema",
      )
      const badId = runTool("allow", "notion.page.get", { id: "../users/me" })
      expect((yield* Effect.flip(badId.run)).message).toBe("notion.page.get input does not match its schema")
      expect(badId.sent).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("notion tools: calls", () => {
  it.effect("creates a page under a data source with its children, as the API expects", () =>
    Effect.gen(function* () {
      const children = briefToBlocks("Brief.")
      const { run, sent } = runTool(
        "allow",
        "notion.page.create",
        {
          dataSourceId: DATA_SOURCE,
          properties: { Ideia: { title: [{ type: "text", text: { content: "Nova" } }] } },
          children,
        },
        { id: "new-page-id-0001", url: "https://www.notion.so/new" },
      )
      expect(yield* run).toEqual({ id: "new-page-id-0001", url: "https://www.notion.so/new" })
      expect(sent[0]?.request).toMatchObject({
        op: "notion.page.create",
        method: "post",
        path: "pages",
        body: { parent: { type: "data_source_id", data_source_id: DATA_SOURCE }, children },
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("appends blocks to a page with a PATCH on its children", () =>
    Effect.gen(function* () {
      const blocks = briefToBlocks("Brief.")
      const { run, sent } = runTool("allow", "notion.page.append", { id: PAGE, blocks }, { results: [{}] })
      expect(yield* run).toEqual({ appended: 1 })
      expect(sent[0]?.request).toMatchObject({
        method: "patch",
        path: `blocks/${PAGE}/children`,
        body: { children: blocks },
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("searches and returns titles without the raw answer", () =>
    Effect.gen(function* () {
      const answer = {
        results: [
          {
            object: "page",
            id: PAGE,
            properties: { Ideia: { type: "title", title: [{ plain_text: "Ideia: X" }] } },
          },
          { object: "data_source", id: DATA_SOURCE, title: [{ plain_text: "Ideias" }] },
        ],
      }
      const { run, sent } = runTool("allow", "notion.search", { query: "ideia" }, answer)
      expect(yield* run).toEqual({
        results: [
          { id: PAGE, object: "page", title: "Ideia: X" },
          { id: DATA_SOURCE, object: "data_source", title: "Ideias" },
        ],
      })
      expect(sent[0]?.request).toMatchObject({ method: "post", path: "search", body: { query: "ideia" } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reads a page and summarises it", () =>
    Effect.gen(function* () {
      const page = fixture("data-source-query.json") as { results: Array<unknown> }
      const { run } = runTool("allow", "notion.page.get", { id: PAGE }, page.results[0])
      expect(yield* run).toEqual({
        id: PAGE,
        url: "https://www.notion.so/Ideia-agendador-3b1f0c2e11114a2b9c3d0000000000a1",
        lastEditedTime: "2026-10-21T10:00:00.000Z",
        title: "Ideia: agendador de pautas",
      })
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("notion connector", () => {
  it("declares its tools with their risk and the two page triggers", () => {
    expect(notionConnector.id).toBe("notion")
    expect(notionConnector.permissions).toEqual([
      { tool: "notion.search", risk: "read" },
      { tool: "notion.page.get", risk: "read" },
      { tool: "notion.page.create", risk: "external" },
      { tool: "notion.page.append", risk: "external" },
    ])
    expect(notionConnector.tools.map((tool) => tool.name)).toEqual(NOTION_TOOLS.map((tool) => tool.name))
    expect(notionConnector.triggers).toEqual(["notion.page_created", "notion.page_updated"])
  })
})
