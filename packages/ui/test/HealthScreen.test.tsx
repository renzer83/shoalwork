import { ApiClient } from "@shoalwork/api-client"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { HealthScreen, StaticApiProvider, themeFor } from "../src/index.js"

const answer =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const healthy = {
  ok: true,
  version: "0.1.0",
  db: "ok",
  dbPath: "shoalwork.db",
  journalMode: "wal",
  uptimeSeconds: 42,
}

const show = (fetchImpl: typeof fetch) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, fetchImpl)}>
        <HealthScreen />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

describe("HealthScreen", () => {
  it("renders ok and db: ok from the core", async () => {
    show(answer(healthy))
    await waitFor(() => expect(screen.getByText("db: ok")).toBeTruthy())
    expect(screen.getByText("ok: yes")).toBeTruthy()
    expect(screen.getByText("version: 0.1.0")).toBeTruthy()
    expect(screen.getByText("uptime: 42s")).toBeTruthy()
  })

  it("shows the degraded database", async () => {
    show(answer({ ...healthy, ok: false, db: "error", dbPath: null, journalMode: null }, 503))
    await waitFor(() => expect(screen.getByText("db: error")).toBeTruthy())
    expect(screen.getByText("Core is degraded")).toBeTruthy()
  })

  it("shows an error banner when the core is unreachable", async () => {
    show(async () => {
      throw new TypeError("fetch failed")
    })
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByText("Cannot reach the core at http://core.test")).toBeTruthy()
  })
})
