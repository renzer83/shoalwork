import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutorsScreen, StaticApiProvider, themeFor } from "../src/index.js"

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"

const EXECUTORS = [
  {
    id: "claude-code",
    cli: "claude",
    installedVersion: "2.1.304",
    pinnedVersion: "2.1.304",
    status: "ok",
    ok: true,
    quota: { executor: "claude-code", usedRatio: 0.85, available: true },
    quality: [
      { kind: "code", okRate: 0.75, n: 4, avgUsd: 0.02 },
      { kind: "chat", okRate: 0.5, n: 10, avgUsd: 0.01 },
    ],
    logins: [{ botId: BOT, authMethod: "claude.ai", state: "logged_in" }],
  },
  {
    id: "codex",
    cli: "codex",
    installedVersion: "0.163.0",
    pinnedVersion: "0.155.1",
    status: "drift",
    ok: false,
    quota: { executor: "codex", usedRatio: 0.1, available: true },
    quality: [],
    logins: [],
  },
]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// A fake core: answers the overview and the re-probe, and records each request as "METHOD /path".
const core = (seen: Array<string>, failOverview = false): typeof fetch => {
  return async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    seen.push(`${method} ${url.pathname}`)
    if (method === "GET" && url.pathname === "/executors") {
      return failOverview ? json({ error: "internal error" }, 500) : json(EXECUTORS)
    }
    if (method === "POST" && url.pathname === "/executors/codex/doctor") {
      return json({ report: { executor: "codex", bin: "codex", status: "ok", installed: "0.155.1" } })
    }
    return json({ error: "not found" }, 404)
  }
}

const show = (seen: Array<string>, failOverview = false) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider
        client={new ApiClient("http://core.test", async () => null, core(seen, failOverview))}
      >
        <ExecutorsScreen />
      </StaticApiProvider>
    </PaperProvider>,
  )

afterEach(cleanup)

describe("ExecutorsScreen", () => {
  it("lists each executor with its version against the pin and the doctor's verdict", async () => {
    show([])
    expect(await screen.findByText("claude-code")).toBeTruthy()
    expect(screen.getByText("CLI claude · instalado 2.1.304 · pin 2.1.304")).toBeTruthy()
    expect(screen.getByText("Doctor: versão diferente do pin")).toBeTruthy()
    expect(screen.getByText("Doctor: OK")).toBeTruthy()
  })

  it("shows the quality of each executor and the logins of its Bots by state and method", async () => {
    show([])
    expect(await screen.findByText(/code · sucesso 75.0% · 4 execuções/)).toBeTruthy()
    expect(screen.getByText(`${BOT} · logado · método claude.ai`)).toBeTruthy()
  })

  it("re-probes only the CLI of the pressed executor, then reloads the overview", async () => {
    const seen: Array<string> = []
    show(seen)
    await screen.findByText("codex")
    fireEvent.click(screen.getAllByRole("button", { name: "Rodar doctor" })[1] as HTMLElement)
    await waitFor(() => expect(seen).toContain("POST /executors/codex/doctor"))
    await waitFor(() => expect(seen.filter((entry) => entry === "GET /executors")).toHaveLength(2))
    expect(seen.some((entry) => entry.includes("/executors/claude-code/doctor"))).toBe(false)
  })

  it("shows the core's HTTP failure as an alert with a retry", async () => {
    show([], true)
    expect(await screen.findByText("O core respondeu HTTP 500")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  })
})
