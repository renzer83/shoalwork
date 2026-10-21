import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { BotsScreen, StaticApiProvider, themeFor } from "../src/index.js"

const BOT_ID = "bot_00000000-0000-4000-8000-0000000000aa"
const EVENT_ID = "evt_00000000-0000-4000-8000-000000000001"

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

// One SSE frame carrying a bot.state_changed event, shaped as the core sends it.
const stateChangedFrame = (to: string): string => {
  const event = {
    id: EVENT_ID,
    streamId: `bot:${BOT_ID}`,
    version: 1,
    position: 1,
    type: "bot.state_changed",
    payload: { botId: BOT_ID, from: "idle", to },
    actor: "system:registry",
    correlationId: "corr-1",
    occurredAt: "2026-10-21T12:00:00.000Z",
  }
  return `id: 1\nevent: bot.state_changed\ndata: ${JSON.stringify(event)}\n\n`
}

const fakeCore =
  (sseText: string): typeof fetch =>
  async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/bots") {
      return json({ bots: [{ id: BOT_ID, name: "lead", role: "coordinator", state: "idle" }] })
    }
    if (path === "/costs") {
      return json({
        rows: [
          { key: BOT_ID, n: 3, tokensIn: 10, tokensOut: 5, usd: 1.5, contextTokensAvg: null, okRate: null },
        ],
        delta: { tokensInPct: null, okRatePct: null },
      })
    }
    if (path === "/events/live") {
      return new Response(sseText, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }

const show = (fetchImpl: typeof fetch) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, fetchImpl)}>
        <BotsScreen />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

describe("BotsScreen", () => {
  it("lists each Bot with its state, role and 24 h cost", async () => {
    show(fakeCore(""))
    await waitFor(() => expect(screen.getByText("lead")).toBeTruthy())
    expect(screen.getByLabelText("state idle")).toBeTruthy()
    expect(screen.getByText("coordinator")).toBeTruthy()
    expect(screen.getByText("cost 24 h: $1.50")).toBeTruthy()
  })

  it("moves the badge when bot.state_changed arrives over SSE", async () => {
    show(fakeCore(stateChangedFrame("working")))
    await waitFor(() => expect(screen.getByLabelText("state working")).toBeTruthy())
    expect(screen.queryByLabelText("state idle")).toBeNull()
  })
})

const ARCHIVED_ID = "bot_00000000-0000-4000-8000-0000000000bb"

// A core whose list is given by the test; the live feed stays empty.
const listCore =
  (
    bots: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly role: string
      readonly state: string
    }>,
  ): typeof fetch =>
  async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/bots") return json({ bots })
    if (path === "/costs") return json({ rows: [], delta: { tokensInPct: null, okRatePct: null } })
    if (path === "/events/live")
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
    return new Response("not found", { status: 404 })
  }

describe("BotsScreen archived Bots", () => {
  const active = { id: BOT_ID, name: "lead", role: "coordinator", state: "idle" }
  const archived = { id: ARCHIVED_ID, name: "old-scout", role: "researcher", state: "archived" }

  it("hides archived Bots until the filter asks for them", async () => {
    show(listCore([active, archived]))
    await waitFor(() => expect(screen.getByText("lead")).toBeTruthy())
    expect(screen.queryByText("old-scout")).toBeNull()

    fireEvent.click(screen.getByText("Show archived"))
    expect(screen.getByText("old-scout")).toBeTruthy()

    fireEvent.click(screen.getByText("Hide archived"))
    expect(screen.queryByText("old-scout")).toBeNull()
  })

  it("says so when every Bot is archived", async () => {
    show(listCore([archived]))
    await waitFor(() => expect(screen.getByText("No active Bots")).toBeTruthy())
    expect(screen.queryByText("old-scout")).toBeNull()
  })
})
