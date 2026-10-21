import { ApiClient } from "@shoalwork/api-client"
import { cleanup, render, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HomeScreen, StaticApiProvider, themeFor } from "../src/index.js"

const healthy = {
  ok: true,
  version: "0.1.0",
  db: "ok",
  dbPath: "shoalwork.db",
  journalMode: "wal",
  uptimeSeconds: 42,
}

const answer =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const unreachable: typeof fetch = async () => {
  throw new TypeError("fetch failed")
}

const show = (fetchImpl: typeof fetch, configured: boolean, onRoute: (href: string) => void) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider
        client={new ApiClient("http://core.test", async () => null, fetchImpl)}
        configured={configured}
      >
        <HomeScreen onRoute={onRoute} />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

describe("HomeScreen", () => {
  it("goes to Conversa when the core answers", async () => {
    const onRoute = vi.fn()
    show(answer(healthy), true, onRoute)
    await waitFor(() => expect(onRoute).toHaveBeenCalledWith("/chat"))
    expect(onRoute).toHaveBeenCalledTimes(1)
  })

  it("goes to Conversa when the core answers, even without a saved base URL", async () => {
    const onRoute = vi.fn()
    show(answer(healthy), false, onRoute)
    await waitFor(() => expect(onRoute).toHaveBeenCalledWith("/chat"))
  })

  it("goes to Setup when the core is unreachable and no base URL was configured", async () => {
    const onRoute = vi.fn()
    show(unreachable, false, onRoute)
    await waitFor(() => expect(onRoute).toHaveBeenCalledWith("/setup"))
    expect(onRoute).toHaveBeenCalledTimes(1)
  })

  it("goes to Health, which explains the failure, when a base URL was configured but the core fails", async () => {
    const onRoute = vi.fn()
    show(answer({ error: "down" }, 503), true, onRoute)
    await waitFor(() => expect(onRoute).toHaveBeenCalledWith("/health"))
    expect(onRoute).toHaveBeenCalledTimes(1)
  })
})
