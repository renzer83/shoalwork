import { Beacon } from "@shoalwork/beacon"
import { streamIds, type TimelinePage } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Statement } from "effect/sql/Statement"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { timelineQuery } from "../src/http/routes/messages-timeline.js"
import {
  AUTH,
  app,
  append,
  bot,
  cleanup,
  fixture,
  get,
  message,
  page,
  prepare,
  runEffect,
  waitingTask,
} from "./messages-fixture.js"

// The plan lines SQLite reports for a statement.
const explain = (sql: SqlClient, statement: Statement<unknown>) => {
  const [text, params] = statement.compile()
  return sql
    .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params)
    .pipe(Effect.map((rows) => rows.map((row) => row.detail)))
}

beforeAll(prepare)
afterAll(cleanup)

describe("POST /messages", () => {
  it("requires the token, rejects a bad body and an unknown bot", async () => {
    expect((await app.request("/messages", { method: "POST" })).status).toBe(401)
    const post = (body: unknown) =>
      app.request("/messages", { method: "POST", headers: AUTH, body: JSON.stringify(body) })
    expect((await post({ botId: bot.id, text: "" })).status).toBe(400)
    expect((await post({ botId: bot.id, text: "   " })).status).toBe(400)
    expect((await post({ botId: bot.id })).status).toBe(400)
    expect((await post({ botId: "no-such-bot", text: "oi" })).status).toBe(404)
    expect((await post({ botId: "bot_00000000-0000-4000-8000-000000000000", text: "oi" })).status).toBe(404)
  })

  it("emits message.inbound on the app channel for a bot id or name", async () => {
    const byId = await app.request("/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ botId: bot.id, text: "oi" }),
    })
    expect(byId.status).toBe(202)
    const { eventId } = (await byId.json()) as { eventId: string }
    const byName = await app.request("/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ botId: "chat-bot", text: "de novo" }),
    })
    expect(byName.status).toBe(202)
    const events = await runEffect(
      Effect.flatMap(Beacon, (beacon) => Stream.runCollect(beacon.readStream(streamIds.bot(bot.id)))).pipe(
        Effect.orDie,
      ),
    )
    const sent = events.find((event) => event.id === eventId)
    expect(sent).toMatchObject({
      type: "message.inbound",
      actor: "user:app",
      payload: { channel: "app", userId: "user:app", text: "oi", botId: bot.id },
    })
  })

  it("accepts a text of 8000 characters and rejects 8001", async () => {
    const send = (text: string) =>
      app.request("/messages", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ botId: bot.id, text }),
      })
    expect((await send("a".repeat(8000))).status).toBe(202)
    expect((await send("a".repeat(8001))).status).toBe(400)
  })
})

describe("GET /messages", () => {
  const shape = (items: TimelinePage["items"]) =>
    items
      .filter(
        (item) => item.kind !== "event" || item.name !== "task_state" || item.text === "fixture-running",
      )
      .map((item) => {
        switch (item.kind) {
          case "message":
            return `${item.direction}:${item.text}`
          case "event":
            return `${item.name}:${item.text}`
          case "approval":
            return `approval:${item.status}`
          case "artifact":
            return `artifact:${item.artifactKind}:${item.ref}`
          default:
            return "unknown"
        }
      })

  const EXPECTED = [
    "in:fixture one",
    "out:fixture two",
    "task_state:fixture-running",
    "command:pnpm test",
    "file_edit:src/a.ts",
    "artifact:pr:https://example.test/pr/1",
    "finished:fixture done",
    "in:fixture three",
  ]

  it("mixes the Bot's messages, events, approval and artifact in log order, leaving out other Bots", async () => {
    const { mine } = await fixture()
    const result = await page(`botId=${mine.id}&limit=200`)
    const items = shape(result.items)
    // The card sits where the request was logged and shows the current status.
    expect(items[0]).toBe("approval:approved")
    expect(items.slice(1)).toEqual(EXPECTED)
    expect(result.nextBefore).toBeNull()
    expect(result.head).toBeGreaterThan(0)
    const positions = result.items.map((item) => item.position)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it("pages backwards with before and forwards with after", async () => {
    const { mine } = await fixture()
    const full = await page(`botId=${mine.id}&limit=200`)
    const collected: Array<TimelinePage["items"][number]> = []
    let cursor: number | null = null
    let pages = 0
    do {
      const query: string =
        cursor === null ? `botId=${mine.id}&limit=3` : `botId=${mine.id}&limit=3&before=${cursor}`
      const next = await page(query)
      collected.unshift(...next.items)
      cursor = next.nextBefore
      pages += 1
    } while (cursor !== null && pages < 20)
    expect(pages).toBeGreaterThan(2)
    expect(collected.map((item) => item.position)).toEqual(full.items.map((item) => item.position))
    const third = full.items[2]
    expect(third).toBeDefined()
    const delta = await page(`botId=${mine.id}&after=${third?.position ?? 0}`)
    expect(delta.items.map((item) => item.position)).toEqual(full.items.slice(3).map((item) => item.position))
    expect(delta.nextBefore).toBeNull()
  })

  it("accepts the Bot name and rejects bad queries", async () => {
    const byName = await page("botId=chat-bot&limit=5")
    expect(byName.items.length).toBeGreaterThan(0)
    expect((await get("")).status).toBe(400)
    expect((await get(`botId=${bot.id}&before=x`)).status).toBe(400)
    expect((await get(`botId=${bot.id}&before=5&after=1`)).status).toBe(400)
    expect((await get(`botId=${bot.id}&limit=0`)).status).toBe(400)
    expect((await get("botId=nobody")).status).toBe(404)
    expect((await app.request("/messages?botId=chat-bot")).status).toBe(401)
  })

  it("keeps a pending approval pending and a message text as plain data", async () => {
    const { mine, approvalId } = await fixture()
    const fresh = await waitingTask(mine)
    await append(message("message.inbound", mine, "<script>alert(1)</script> **bold**"))
    const result = await page(`botId=${mine.id}&limit=200`)
    const card = result.items.find((item) => item.kind === "approval" && item.approvalId === fresh.approvalId)
    expect(card).toMatchObject({
      status: "pending",
      tool: "Bash",
      risk: "irreversible",
      input: '"rm -rf build"',
    })
    expect(result.items.some((item) => item.kind === "approval" && item.approvalId === approvalId)).toBe(true)
    const last = result.items.at(-1)
    expect(last).toMatchObject({ kind: "message", text: "<script>alert(1)</script> **bold**" })
  })

  it("reads the log only through the stream index, never by type or by a full scan", async () => {
    const plan = await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        const before = yield* explain(sql, timelineQuery(sql, bot.id, "e.position < ", 999, "DESC", 51))
        const after = yield* explain(sql, timelineQuery(sql, bot.id, "e.position > ", 0, "ASC", 51))
        return [...before, ...after]
      }),
    )
    // Accesses to the events table (aliased e): all of them go through the stream_id index.
    const onEvents = plan.filter((detail) => /^(SCAN|SEARCH) (e|events)\b/.test(detail))
    expect(onEvents.length).toBeGreaterThanOrEqual(4)
    for (const detail of onEvents) {
      expect(detail).toMatch(/^SEARCH (e|events) USING INDEX sqlite_autoindex_events_\d \(stream_id=\?\)/)
    }
  })
})
