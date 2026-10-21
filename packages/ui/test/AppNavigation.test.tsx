/// <reference lib="dom" />
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Text } from "react-native"
import { PaperProvider } from "react-native-paper"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppNavigation, NAV_ENTRIES, themeFor, visibleNavEntries } from "../src/index.js"

const viewport = vi.hoisted(() => ({ width: 1280 }))

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>()
  return {
    ...actual,
    useWindowDimensions: () => ({ width: viewport.width, height: 800, scale: 1, fontScale: 1 }),
  }
})

const show = (pathname: string, onNavigate = vi.fn()) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <AppNavigation pathname={pathname} onNavigate={onNavigate}>
        <Text>screen body</Text>
      </AppNavigation>
    </PaperProvider>,
  )

beforeEach(() => {
  viewport.width = 1280
})
afterEach(cleanup)

describe("AppNavigation", () => {
  it("renders the visible entries, Projetos and Times included", () => {
    show("/")
    for (const label of ["Conversa", "Bots", "Saúde", "Configurar", "Projetos", "Times"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy()
    }
    expect(screen.getByText("screen body")).toBeTruthy()
  })

  it("marks the entry of the current section as selected, including its sub-pages", () => {
    show("/bots/bot_1")
    expect(screen.getByRole("button", { name: "Bots" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("button", { name: "Conversa" }).getAttribute("aria-current")).toBeNull()
  })

  it("does not select Bots for a path that only shares its prefix", () => {
    show("/botsx")
    expect(screen.getByRole("button", { name: "Bots" }).getAttribute("aria-current")).toBeNull()
  })

  it("navigates to the entry href when pressed", () => {
    const onNavigate = vi.fn()
    show("/", onNavigate)
    fireEvent.click(screen.getByRole("button", { name: "Saúde" }))
    expect(onNavigate).toHaveBeenCalledWith("/health")
  })

  it("navigates with the keyboard Enter key on a focused entry", () => {
    const onNavigate = vi.fn()
    show("/", onNavigate)
    const item = screen.getByRole("button", { name: "Bots" })
    item.focus()
    expect(document.activeElement).toBe(item)
    fireEvent.keyDown(item, { key: "Enter" })
    expect(onNavigate).toHaveBeenCalledWith("/bots")
  })

  it("shows a labelled sidebar with the app title on wide windows", () => {
    show("/")
    const menu = screen.getByRole("navigation", { name: "Main menu" })
    expect(menu.textContent).toContain("Conversa")
    expect(screen.getByText("Shoalwork")).toBeTruthy()
  })

  it("keeps the same entries in a bottom bar, without the title, on narrow windows", () => {
    viewport.width = 390
    show("/chat/lead")
    expect(screen.getAllByRole("navigation", { name: "Main menu" })).toHaveLength(1)
    expect(screen.queryByText("Shoalwork")).toBeNull()
    expect(screen.getByRole("button", { name: "Conversa" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByText("screen body")).toBeTruthy()
  })

  it("lists only ready entries from the central list", () => {
    expect(visibleNavEntries().map((entry) => entry.href)).toEqual([
      "/chat",
      "/bots",
      "/health",
      "/setup",
      "/projects",
      "/pods",
      "/beacon",
    ])
    expect(
      NAV_ENTRIES.filter((entry) => entry.href === "/projects" || entry.href === "/pods").every(
        (entry) => entry.ready,
      ),
    ).toBe(true)
  })
})
