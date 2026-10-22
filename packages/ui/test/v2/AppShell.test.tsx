/// <reference lib="dom" />
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { Text } from "react-native"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "../../src/shell/AppShell.js"
import { shellMetrics } from "../../src/shell/shell-metrics.js"
import {
  BOTS,
  costsEmpty,
  fakeCore,
  iso,
  json,
  LOAD,
  message,
  OBRA,
  page,
  renderPt,
  rowName,
} from "./support.js"

const viewport = vi.hoisted(() => ({ width: 1585 }))

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>()
  return {
    ...actual,
    useWindowDimensions: () => ({ width: viewport.width, height: 992, scale: 1, fontScale: 1 }),
  }
})

beforeEach(() => {
  viewport.width = 1585
})
afterEach(cleanup)

// A core with the bots of the sidebar and one message per Bot that has one.
const core = (failBots = false) =>
  fakeCore((call) => {
    if (call.path === "/bots") {
      return failBots ? json({ error: "boom" }, 500) : json({ bots: BOTS })
    }
    if (call.path.startsWith("/costs")) return costsEmpty()
    if (call.path.startsWith("/messages?")) {
      const botId = new URL(`http://core.test${call.path}`).searchParams.get("botId") ?? ""
      const items =
        botId === OBRA ? [{ ...message(1, "out", "Decisões registradas em #949"), occurredAt: iso(0) }] : []
      return json(page(botId, items))
    }
    return undefined
  })

const show = (pathname: string, failBots = false) => {
  const onNavigate = vi.fn()
  const fake = core(failBots)
  renderPt(
    fake.client,
    <AppShell pathname={pathname} onNavigate={onNavigate}>
      <Text>centro</Text>
    </AppShell>,
  )
  return { onNavigate, fake }
}

describe("shellMetrics", () => {
  it("matches the reference at 1585 px and scales down below it", () => {
    expect(shellMetrics(1585)).toEqual({ sidebarWidth: 428, panelWidth: 340, narrow: false })
    expect(shellMetrics(1100)).toEqual({ sidebarWidth: 297, panelWidth: 260, narrow: false })
    expect(shellMetrics(900)).toEqual({ sidebarWidth: 280, panelWidth: 0, narrow: false })
    expect(shellMetrics(390)).toEqual({ sidebarWidth: 390, panelWidth: 0, narrow: true })
    expect(shellMetrics(3000).sidebarWidth).toBe(430)
  })
})

describe("AppShell", () => {
  it("draws the Guide hero, the Bots grouped by project with their last message, and the screen", async () => {
    show("/chat/lead")
    expect(screen.getByText("Guia · Coordenador")).toBeTruthy()
    expect(screen.getByText("centro")).toBeTruthy()
    await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    for (const title of ["ObraBoss", "Faturium", "Sem projeto"]) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(screen.getByRole("button", { name: rowName("seo-desk") })).toBeTruthy()
    expect(screen.queryByRole("button", { name: rowName("lead") })).toBeNull()
    await screen.findByText("Decisões registradas em #949", {}, LOAD)
    expect(screen.getByText("Online")).toBeTruthy()
  })

  it("navigates to a Bot, to the Guide and to Configurações", async () => {
    const { onNavigate } = show("/chat/lead")
    fireEvent.click(await screen.findByRole("button", { name: rowName("faturium-dev") }, LOAD))
    expect(onNavigate).toHaveBeenLastCalledWith("/chat/faturium-dev")
    fireEvent.click(screen.getByRole("button", { name: "Abrir a conversa com o Guia" }))
    expect(onNavigate).toHaveBeenLastCalledWith("/chat/lead")
    fireEvent.click(screen.getByRole("button", { name: "Configurações" }))
    expect(onNavigate).toHaveBeenLastCalledWith("/settings")
  })

  it("marks the open chat and the settings page", async () => {
    show("/chat/obraboss-ux")
    const row = await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    expect(row.getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("button", { name: "Configurações" }).getAttribute("aria-current")).toBeNull()
    cleanup()
    show("/settings")
    await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    expect(screen.getByRole("button", { name: "Configurações" }).getAttribute("aria-current")).toBe("page")
  })

  it("filters the list from the search button", async () => {
    show("/chat/lead")
    await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Filtrar bots" }), { target: { value: "seo" } })
    expect(screen.queryByRole("button", { name: rowName("obraboss-ux") })).toBeNull()
    expect(screen.getByRole("button", { name: rowName("seo-desk") })).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "Filtrar bots" }), { target: { value: "zzz" } })
    expect(screen.getByText("Nenhum Bot encontrado")).toBeTruthy()
  })

  it("closing the search drops the filter and every Bot is back", async () => {
    show("/chat/lead")
    await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Filtrar bots" }), { target: { value: "seo" } })
    expect(screen.queryByRole("button", { name: rowName("obraboss-ux") })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }))
    expect(screen.queryByRole("textbox", { name: "Filtrar bots" })).toBeNull()
    for (const name of ["obraboss-ux", "faturium-dev", "seo-desk"]) {
      expect(screen.getByRole("button", { name: rowName(name) })).toBeTruthy()
    }
    // Opening it again starts empty.
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }))
    expect((screen.getByRole("textbox", { name: "Filtrar bots" }) as HTMLInputElement).value).toBe("")
  })

  it("opens the creation form in a modal from the + button and closes it", async () => {
    show("/chat/lead")
    await screen.findByRole("button", { name: rowName("obraboss-ux") }, LOAD)
    expect(screen.queryByRole("button", { name: "Fechar" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Novo Bot" }))
    fireEvent.click(await screen.findByRole("button", { name: "Fechar" }, LOAD))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Fechar" })).toBeNull(), LOAD)
  })

  it("says so when the core cannot be read", async () => {
    show("/chat/lead", true)
    expect((await screen.findByRole("alert", {}, LOAD)).textContent).toContain("HTTP 500")
  })

  it("has no sidebar on the routes that are about reaching the core", () => {
    show("/setup")
    expect(screen.getByText("centro")).toBeTruthy()
    expect(screen.queryByText("Guia · Coordenador")).toBeNull()
  })

  it("on a phone shows the list at /chat and the screen elsewhere, never both", () => {
    viewport.width = 390
    show("/chat")
    expect(screen.getByText("Guia · Coordenador")).toBeTruthy()
    expect(screen.queryByText("centro")).toBeNull()
    cleanup()
    show("/chat/lead")
    expect(screen.getByText("centro")).toBeTruthy()
    expect(screen.queryByText("Guia · Coordenador")).toBeNull()
  })
})
