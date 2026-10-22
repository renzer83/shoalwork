/// <reference lib="dom" />

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsScreen } from "../../src/screens/v2/SettingsScreen.js"
import { ShellContext } from "../../src/shell/shell-context.js"
import { BOTS, fakeCore, json, LOAD, renderPt } from "./support.js"

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

const EXECUTOR_VIEW = {
  id: "claude-code",
  cli: "claude",
  installedVersion: "2.1.304",
  pinnedVersion: "2.1.304",
  status: "ok",
  ok: true,
  quota: { executor: "claude-code", usedRatio: 0.4, available: true },
  quality: [],
  logins: [],
}

const setup = (shell?: { narrow?: boolean; openList?: () => void }) => {
  const core = fakeCore((call) => {
    if (call.path === "/executors") return json([EXECUTOR_VIEW])
    if (call.path === "/bots") return json({ bots: BOTS })
    if (call.path === "/connectors") return json({ connectors: [] })
    return undefined
  })
  renderPt(
    core.client,
    <ShellContext.Provider
      value={{
        narrow: shell?.narrow ?? false,
        openList: shell?.openList ?? vi.fn(),
        openSearch: vi.fn(),
      }}
    >
      <SettingsScreen />
    </ShellContext.Provider>,
  )
  return core
}

describe("SettingsScreen", () => {
  it("renders the executors tab by default", async () => {
    setup()
    await waitFor(() => expect(screen.getByText("Executores de IA")).toBeTruthy(), LOAD)
    expect(screen.getByRole("tab", { name: "Executores & Modelos" })).toBeTruthy()
  })

  it("renders the apps tab when selected", async () => {
    setup()
    fireEvent.click(screen.getByRole("tab", { name: "Apps Conectadas" }))
    await waitFor(() => expect(screen.getByText("Apps conectadas")).toBeTruthy(), LOAD)
  })

  it("renders the routing tab when selected", async () => {
    setup()
    fireEvent.click(screen.getByRole("tab", { name: "Padrões & Roteamento" }))
    await waitFor(() => expect(screen.getByText("Ordem de resposta do Guia")).toBeTruthy(), LOAD)
  })

  it("renders the policies tab when selected", async () => {
    setup()
    fireEvent.click(screen.getByRole("tab", { name: "Políticas" }))
    await waitFor(
      () =>
        expect(
          screen.getByText("Como a chamada de ferramenta de um Bot é decidida antes de rodar."),
        ).toBeTruthy(),
      LOAD,
    )
  })

  it("renders the general tab when selected", async () => {
    setup()
    fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
    await waitFor(() => expect(screen.getByText("Onde o core está e o idioma do app.")).toBeTruthy(), LOAD)
  })

  it("renders the back button in narrow mode and triggers openList", async () => {
    viewport.width = 390
    const openList = vi.fn()
    setup({ narrow: true, openList })
    const backButton = screen.getByRole("button", { name: "Voltar aos Bots" })
    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)
    expect(openList).toHaveBeenCalled()
  })

  it("renders the header and save button", async () => {
    setup()
    expect(screen.getByText("Configuração")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeTruthy()
  })

  it("renders the executors section heading and add button", async () => {
    setup()
    await waitFor(() => expect(screen.getByText("Executores de IA")).toBeTruthy(), LOAD)
    expect(screen.getByRole("button", { name: "Adicionar executor" })).toBeTruthy()
  })
})
