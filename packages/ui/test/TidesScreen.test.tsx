import { ApiClient } from "@shoalwork/api-client"
import { newBotId, newTideId } from "@shoalwork/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { StaticApiProvider, TidesScreen, themeFor } from "../src/index.js"

const BOT_ID = newBotId()
const TIDE_ID = newTideId()

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const tide = {
  id: TIDE_ID,
  botId: BOT_ID,
  name: "nightly",
  kind: "cron",
  cronExpr: "0 9 * * 1-5",
  timezone: "UTC",
  cooldownSeconds: 60,
  maxFiresPerHour: 30,
  taskTemplate: {
    title: "Morning report",
    prompt: "summarize",
    kind: "routine",
    tier: "light",
    budget: { tokens: 1000, seconds: 60, usd: 0.1 },
  },
  enabled: true,
}

// The core's answer to a cron it cannot run: the expression is named, as the Tides service writes it.
const fakeCore = (method: string | undefined, path: string): Response | undefined => {
  if (path === "/tides" && method === "GET") return json({ tides: [tide] })
  if (path === "/bots") return json({ bots: [{ id: BOT_ID, name: "dev", role: "developer", state: "idle" }] })
  if (path === "/tides" && method === "POST") {
    return json({ error: "invalid request", where: "cronExpr:not a cron" }, 400)
  }
  return undefined
}

const coreFetch: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname
  const answer = fakeCore(init?.method, path)
  return answer ?? new Response("not found", { status: 404 })
}

const show = () =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, coreFetch)}>
        <TidesScreen />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

describe("TidesScreen", () => {
  it("lists each Tide with its Bot and schedule", async () => {
    show()
    expect(await screen.findByText("dev · cron 0 9 * * 1-5")).toBeTruthy()
    expect(screen.getByText("nightly")).toBeTruthy()
    expect(screen.getByText("Run now")).toBeTruthy()
  })

  it("shows the cron error the core answers with", async () => {
    show()
    await screen.findByText("dev · cron 0 9 * * 1-5")
    fireEvent.change(screen.getByTestId("tide-bot"), { target: { value: "dev" } })
    fireEvent.change(screen.getByTestId("tide-name"), { target: { value: "broken" } })
    fireEvent.change(screen.getByTestId("tide-cron"), { target: { value: "not a cron" } })
    fireEvent.change(screen.getByTestId("tide-title"), { target: { value: "t" } })
    fireEvent.change(screen.getByTestId("tide-prompt"), { target: { value: "p" } })
    fireEvent.click(screen.getByText("Save Tide"))
    expect(await screen.findByText(/cronExpr:not a cron/)).toBeTruthy()
  })
})
