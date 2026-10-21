import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { BeaconScreen, StaticApiProvider, themeFor } from "../src/index.js"

const SAVINGS = {
  decisions: { total: 4, rule: 2, cache: 1, model: 1, localPct: 75 },
  haikuRuns: 2,
  decisionUsd: 0.03,
  avoidedUsd: 0.09,
  context: {
    assembled: 1,
    tokensBefore: 1000,
    tokensAfter: 600,
    tokensCut: 400,
    cutPct: 40,
    droppedItems: 3,
    usdPerInputToken: 0.0001,
    avoidedUsd: 0.04,
  },
}

const COSTS = {
  rows: [
    { key: "light", n: 1, tokensIn: 500, tokensOut: 50, usd: 0.05, contextTokensAvg: null, okRate: 1 },
    { key: "unknown", n: 0, tokensIn: 100, tokensOut: 10, usd: 0.01, contextTokensAvg: null, okRate: null },
  ],
  delta: { tokensInPct: null, okRatePct: null },
}

const DAILY = {
  days: [
    { day: "2026-10-19", n: 0, usd: 0 },
    { day: "2026-10-20", n: 2, usd: 0.04 },
    { day: "2026-10-21", n: 1, usd: 0.02 },
  ],
}

const event = (position: number, type: string, streamId: string, payload: unknown) => ({
  id: `evt_00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
  streamId,
  version: position,
  position,
  type,
  payload,
  actor: "system:test",
  correlationId: "corr_farol_ui",
  occurredAt: "2026-10-21T10:00:00.000Z",
})

const DECISION = event(7, "decision.made", "task:task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", {
  decisionId: "dec_7",
  source: "rule",
})
const USAGE = event(6, "usage.recorded", "task:task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", {
  model: "claude-haiku-5-5",
})
const OLDER = event(3, "executor.finished", "bot:bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41", {
  verdict: { kind: "ok" },
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// A fake core: answers each Farol route from the fixtures above, filtering the events like the real route does.
const core = (seen: Array<string>): typeof fetch => {
  return async (input) => {
    const url = new URL(String(input))
    seen.push(url.pathname + url.search)
    if (url.pathname === "/beacon/savings") return json(SAVINGS)
    if (url.pathname === "/beacon/costs/daily") return json(DAILY)
    if (url.pathname === "/beacon/costs") return json(COSTS)
    if (url.pathname === "/beacon/events") {
      const q = url.searchParams.get("q")
      if (q !== null) {
        const matches = [USAGE, DECISION, OLDER].filter((e) => JSON.stringify(e).includes(q))
        return json({ events: matches, nextBefore: null })
      }
      if (url.searchParams.get("before") === "6") return json({ events: [OLDER], nextBefore: null })
      return json({ events: [DECISION, USAGE], nextBefore: 6 })
    }
    return json({ error: "not found" }, 404)
  }
}

const show = (seen: Array<string>) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, core(seen))}>
        <BeaconScreen />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

// Each wait is bounded on its own. A case gets more than its waits add up to (up to four waits per case),
// so a slow runner fails on a named wait instead of hitting the test timeout.
const WAIT = { timeout: 4_000 }
const CASE_TIMEOUT = 20_000

describe("BeaconScreen", () => {
  it(
    "shows the savings of the period from the savings fixture",
    async () => {
      show([])
      await screen.findByText("75.0%", {}, WAIT)
      await screen.findByText("US$ 0.0900", {}, WAIT)
      await screen.findByText("40.0%", {}, WAIT)
      await screen.findByText("US$ 0.0400", {}, WAIT)
    },
    CASE_TIMEOUT,
  )

  it(
    "draws one bar per day of the daily cost",
    async () => {
      show([])
      const chart = await screen.findByLabelText("Custo por dia (USD): 3 barras", {}, WAIT)
      await waitFor(() => expect(chart.querySelectorAll("rect")).toHaveLength(3), WAIT)
    },
    CASE_TIMEOUT,
  )

  it(
    "sends the free-text search as q and shows only the matching events",
    async () => {
      const seen: Array<string> = []
      show(seen)
      await screen.findByText("decision.made", {}, WAIT)
      const search = await screen.findByLabelText("Busca no log", {}, WAIT)
      fireEvent.change(search, { target: { value: "haiku" } })
      const button = await screen.findByRole("button", { name: "Buscar" }, WAIT)
      fireEvent.click(button)
      await waitFor(() => expect(seen.some((url) => url.includes("q=haiku"))).toBe(true), WAIT)
      await waitFor(() => expect(screen.queryByText("decision.made")).toBeNull(), WAIT)
      await screen.findByText("usage.recorded", {}, WAIT)
    },
    CASE_TIMEOUT,
  )

  it(
    "pages older events with the cursor of the previous page",
    async () => {
      const seen: Array<string> = []
      show(seen)
      await screen.findByText("usage.recorded", {}, WAIT)
      expect(screen.queryByText("executor.finished")).toBeNull()
      const more = await screen.findByRole("button", { name: "Carregar mais" }, WAIT)
      fireEvent.click(more)
      await screen.findByText("executor.finished", {}, WAIT)
      expect(seen.some((url) => url.includes("/beacon/events") && url.includes("before=6"))).toBe(true)
      await screen.findByText("decision.made", {}, WAIT)
    },
    CASE_TIMEOUT,
  )

  it(
    "prints the selected event's payload as text",
    async () => {
      show([])
      const row = await screen.findByRole("button", { name: /decision\.made/ }, WAIT)
      fireEvent.click(row)
      await screen.findByText(/"source": "rule"/, {}, WAIT)
    },
    CASE_TIMEOUT,
  )

  it(
    "asks the core for the window of the chosen period",
    async () => {
      const seen: Array<string> = []
      show(seen)
      await waitFor(
        () => expect(seen.some((url) => url.startsWith("/beacon/savings?since=7d"))).toBe(true),
        WAIT,
      )
      const period = await screen.findByRole("button", { name: "Período 24 h" }, WAIT)
      fireEvent.click(period)
      await waitFor(
        () => expect(seen.some((url) => url.startsWith("/beacon/savings?since=24h"))).toBe(true),
        WAIT,
      )
    },
    CASE_TIMEOUT,
  )
})
