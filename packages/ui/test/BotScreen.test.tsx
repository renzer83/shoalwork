/// <reference lib="dom" />
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BotScreen } from "../src/index.js"
import { BOT, type Call, fakeCore, json, renderWith } from "./chat-support.js"

afterEach(cleanup)

// The ficha loads in three requests (bot, costs, then the memory list), and the feed connects after the first render.
// Each wait names the screen state it needs; the bound is for a loaded machine, not a sleep.
const LOAD_TIMEOUT = { timeout: 5000 }

// The ficha as GET /bots/:id answers it: the full Bot definition plus the live state.
const botDetail = (state: string) => ({
  id: BOT,
  name: "lead",
  role: "coordinator",
  instructions: "Coordinate the work.",
  kind: "fixed",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 300000, seconds: 900, usd: 3 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
  state,
})

const costs = () =>
  json({
    rows: [{ key: BOT, n: 1, tokensIn: 10, tokensOut: 5, usd: 1, contextTokensAvg: null, okRate: null }],
    delta: { tokensInPct: null, okRatePct: null },
  })

const memoryHit = (id: string, content: string) => ({
  id,
  scope: "bot",
  ownerId: BOT,
  kind: "semantic",
  content,
})

const isPost = (call: Call, path: string): boolean => call.method === "POST" && call.path === path

describe("BotScreen controls", () => {
  it("pausing sends POST /control/pause for the Bot and the ficha shows it paused", async () => {
    let paused = false
    const core = fakeCore((call) => {
      if (isPost(call, "/control/pause")) {
        paused = true
        return json({ ok: true })
      }
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail(paused ? "paused" : "idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Pause"))

    await screen.findByText("state: paused", {}, LOAD_TIMEOUT)
    expect(screen.getByText("Resume")).toBeTruthy()
    expect(core.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/control/pause", body: { bot: BOT } },
    ])
  })

  it("resuming a paused Bot sends POST /control/resume", async () => {
    let paused = true
    const core = fakeCore((call) => {
      if (isPost(call, "/control/resume")) {
        paused = false
        return json({ ok: true })
      }
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail(paused ? "paused" : "idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: paused", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Resume"))

    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)
    expect(core.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/control/resume", body: { bot: BOT } },
    ])
  })

  it("shows the refusal when the core does not accept the pause", async () => {
    const core = fakeCore((call) => {
      if (isPost(call, "/control/pause")) return json({ error: "not found" }, 404)
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Pause"))

    await screen.findByText("pause failed (HTTP 404)", {}, LOAD_TIMEOUT)
    expect(screen.getByText("state: idle")).toBeTruthy()
  })

  it("moves the state when bot.state_changed arrives over the live feed", async () => {
    const core = fakeCore((call) => {
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)

    // The feed connects after the first render; push until the frame lands.
    await waitFor(() => {
      core.push(1, "bot.state_changed", { botId: BOT, from: "idle", to: "paused" })
      expect(screen.getByText("state: paused")).toBeTruthy()
    }, LOAD_TIMEOUT)
  })
})

describe("MemoryList edit", () => {
  it("editing an item sends PATCH /memory/:id as the app and shows the superseding item", async () => {
    let edited = false
    const core = fakeCore((call) => {
      if (call.method === "PATCH" && call.path === "/memory/mem-1") {
        edited = true
        return json({ item: memoryHit("mem-2", "new text") })
      }
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) {
        return json([edited ? memoryHit("mem-2", "new text") : memoryHit("mem-1", "old text")])
      }
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("old text", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "new text" } })
    fireEvent.click(screen.getByText("Save memory"))

    await screen.findByText("new text", {}, LOAD_TIMEOUT)
    expect(screen.queryByText("old text")).toBeNull()
    expect(core.calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/memory/mem-1", body: { content: "new text", userId: "app" } },
    ])
  })

  it("refuses an empty memory before anything is sent", async () => {
    const core = fakeCore((call) => {
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([memoryHit("mem-1", "old text")])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("old text", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "   " } })
    fireEvent.click(screen.getByText("Save memory"))

    await screen.findByText("Memory cannot be empty", {}, LOAD_TIMEOUT)
    expect(core.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  it("keeps the editor open and shows the status when the core refuses the edit", async () => {
    const core = fakeCore((call) => {
      if (call.method === "PATCH") return json({ error: "bad request" }, 400)
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([memoryHit("mem-1", "old text")])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("old text", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "new text" } })
    fireEvent.click(screen.getByText("Save memory"))

    await screen.findByText("Could not save (HTTP 400)", {}, LOAD_TIMEOUT)
    expect(screen.getByLabelText("Memory text")).toBeTruthy()
  })
})

describe("BotScreen archive", () => {
  it("asks for confirmation, then sends POST /bots/:id/archive and shows the Bot as archived", async () => {
    let archived = false
    const core = fakeCore((call) => {
      if (isPost(call, `/bots/${BOT}/archive`)) {
        archived = true
        return json({ bot: botDetail("archived") })
      }
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail(archived ? "archived" : "idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Archive"))
    expect(core.calls.some((call) => call.method === "POST")).toBe(false)
    fireEvent.click(screen.getByText("Confirm archive"))

    await screen.findByText("state: archived", {}, LOAD_TIMEOUT)
    expect(
      screen.getByText("Archived: this Bot takes no new tasks. Its memory and history stay."),
    ).toBeTruthy()
    expect(core.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: `/bots/${BOT}/archive`, body: {} },
    ])
  })

  it("keeps the Bot when the confirmation is dismissed", async () => {
    const core = fakeCore((call) => {
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: idle", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Archive"))
    fireEvent.click(screen.getByText("Keep"))

    expect(screen.getByText("Archive")).toBeTruthy()
    expect(core.calls.some((call) => call.method === "POST")).toBe(false)
  })

  it("shows the refusal when the Bot holds a task in progress", async () => {
    const core = fakeCore((call) => {
      if (isPost(call, `/bots/${BOT}/archive`)) {
        return json({ error: "conflict", reason: "bot has a task in progress" }, 409)
      }
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("working") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("state: working", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("Archive"))
    fireEvent.click(screen.getByText("Confirm archive"))

    await screen.findByText("archive failed (HTTP 409)", {}, LOAD_TIMEOUT)
    expect(screen.getByText("state: working")).toBeTruthy()
  })
})

describe("MemoryList history", () => {
  const versions = [
    {
      id: "mem-0",
      scope: "bot",
      ownerId: BOT,
      kind: "semantic",
      content: "first **text** <i>kept</i>",
      createdAt: "2026-10-20T10:00:00.000Z",
      supersededBy: "mem-1",
      forgotten: false,
    },
    {
      id: "mem-1",
      scope: "bot",
      ownerId: BOT,
      kind: "semantic",
      content: "earlier text",
      createdAt: "2026-10-21T09:00:00.000Z",
      supersededBy: null,
      forgotten: false,
    },
  ]

  it("shows the earlier versions of an item, oldest first, with their text as plain data", async () => {
    const core = fakeCore((call) => {
      if (call.path === "/memory/mem-1/history") return json({ items: versions })
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([memoryHit("mem-1", "current text")])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("current text", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("History"))

    await screen.findByText("first **text** <i>kept</i>", {}, LOAD_TIMEOUT)
    expect(screen.getByText("1. superseded · 2026-10-20T10:00:00.000Z")).toBeTruthy()
    expect(screen.getByText("2. current · 2026-10-21T09:00:00.000Z")).toBeTruthy()
    expect(screen.getByText("earlier text")).toBeTruthy()
    expect(core.calls.filter((call) => call.path === "/memory/mem-1/history")).toHaveLength(1)
  })

  it("shows the status when the core refuses the history", async () => {
    const core = fakeCore((call) => {
      if (call.path === "/memory/mem-1/history") return json({ error: "not found" }, 404)
      if (call.path === `/bots/${BOT}`) return json({ bot: botDetail("idle") })
      if (call.path.startsWith("/costs")) return costs()
      if (call.path.startsWith("/memory")) return json([memoryHit("mem-1", "current text")])
      return undefined
    })
    renderWith(core.client, <BotScreen idOrName={BOT} />)
    await screen.findByText("current text", {}, LOAD_TIMEOUT)

    fireEvent.click(screen.getByText("History"))

    await screen.findByText("History failed (HTTP 404)", {}, LOAD_TIMEOUT)
  })
})
