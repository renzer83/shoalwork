/// <reference lib="dom" />
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BotScreen } from "../src/index.js"
import { BOT, type Call, fakeCore, json, renderWith } from "./chat-support.js"

afterEach(cleanup)

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
    await waitFor(() => expect(screen.getByText("state: idle")).toBeTruthy())

    fireEvent.click(screen.getByText("Pause"))

    await waitFor(() => expect(screen.getByText("state: paused")).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText("state: paused")).toBeTruthy())

    fireEvent.click(screen.getByText("Resume"))

    await waitFor(() => expect(screen.getByText("state: idle")).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText("state: idle")).toBeTruthy())

    fireEvent.click(screen.getByText("Pause"))

    await waitFor(() => expect(screen.getByText("pause failed (HTTP 404)")).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText("state: idle")).toBeTruthy())

    // The feed connects after the first render; push until the frame lands.
    await waitFor(() => {
      core.push(1, "bot.state_changed", { botId: BOT, from: "idle", to: "paused" })
      expect(screen.getByText("state: paused")).toBeTruthy()
    })
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
    await waitFor(() => expect(screen.getByText("old text")).toBeTruthy())

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "new text" } })
    fireEvent.click(screen.getByText("Save memory"))

    await waitFor(() => expect(screen.getByText("new text")).toBeTruthy())
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
    await waitFor(() => expect(screen.getByText("old text")).toBeTruthy())

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "   " } })
    fireEvent.click(screen.getByText("Save memory"))

    expect(screen.getByText("Memory cannot be empty")).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText("old text")).toBeTruthy())

    fireEvent.click(screen.getByText("Edit"))
    fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "new text" } })
    fireEvent.click(screen.getByText("Save memory"))

    await waitFor(() => expect(screen.getByText("Could not save (HTTP 400)")).toBeTruthy())
    expect(screen.getByLabelText("Memory text")).toBeTruthy()
  })
})
