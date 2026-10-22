/// <reference lib="dom" />
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider, themeFor, translate } from "../../src/index.js"
import { BotGroupList } from "../../src/shell/BotGroupList.js"
import { chatTarget, groupBots, whenLabel } from "../../src/shell/bot-groups.js"
import { BOTS, FATU, OBRA, rowName, summary } from "./support.js"

afterEach(cleanup)

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("pt-BR", key, params)

describe("groupBots", () => {
  it("groups by project, keeps the Guide out and puts 'Sem projeto' last", () => {
    const groups = groupBots([summary("bot_00000000-0000-4000-8000-0000000000b0", "alpha-desk"), ...BOTS], t)
    expect(groups.map((group) => [group.title, group.bots.map((bot) => bot.name)])).toEqual([
      ["ObraBoss", ["obraboss-ux"]],
      ["Faturium", ["faturium-dev"]],
      ["Sem projeto", ["alpha-desk", "seo-desk"]],
    ])
    expect(groups.at(-1)?.key).toBe("")
  })

  it("filters by name or role and drops empty groups", () => {
    expect(groupBots(BOTS, t, "obra").map((group) => group.title)).toEqual(["ObraBoss"])
    expect(groupBots(BOTS, t, "  DEVELOPER ").map((group) => group.title)).toEqual([
      "ObraBoss",
      "Faturium",
      "Sem projeto",
    ])
    expect(groupBots(BOTS, t, "zzz")).toEqual([])
  })

  it("treats a blank project as no project", () => {
    expect(groupBots([summary(OBRA, "a", "   ")], t).map((group) => group.title)).toEqual(["Sem projeto"])
  })
})

describe("whenLabel and chatTarget", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime()
  it("shows the hour today, Ontem yesterday and the date before", () => {
    expect(whenLabel(new Date(2026, 9, 21, 14, 3).getTime(), now, t)).toBe("14:03")
    expect(whenLabel(new Date(2026, 9, 20, 23, 59).getTime(), now, t)).toBe("Ontem")
    expect(whenLabel(new Date(2026, 9, 12, 8, 0).getTime(), now, t)).toBe("12/10")
  })

  it("reads the Bot of a /chat path", () => {
    expect(chatTarget("/chat/lead")).toBe("lead")
    expect(chatTarget("/chat/bot%20x/extra")).toBe("bot x")
    expect(chatTarget("/settings")).toBeUndefined()
  })
})

describe("BotGroupList", () => {
  const now = () => new Date(2026, 9, 21, 15, 0).getTime()
  const show = (onOpen = vi.fn(), activeRef: string | undefined = undefined) => {
    render(
      <PaperProvider theme={themeFor("dark")}>
        <LocaleProvider locale="pt-BR">
          <BotGroupList
            groups={groupBots(BOTS, t)}
            previews={{
              [OBRA]: {
                text: "Decisões registradas\nem #949, e up...",
                at: new Date(2026, 9, 21, 14, 3).getTime(),
              },
              [FATU]: { text: "Deploy concluído", at: new Date(2026, 9, 20, 12, 21).getTime() },
            }}
            activeRef={activeRef}
            onOpen={onOpen}
            now={now}
          />
        </LocaleProvider>
      </PaperProvider>,
    )
    return onOpen
  }

  it("shows a header with the count per group and the last message with its time", () => {
    show()
    for (const title of ["ObraBoss", "Faturium", "Sem projeto"]) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(screen.getAllByText("1")).toHaveLength(3)
    expect(screen.getByText("Decisões registradas em #949, e up...")).toBeTruthy()
    expect(screen.getByText("14:03")).toBeTruthy()
    expect(screen.getByText("Ontem")).toBeTruthy()
    expect(screen.getByText("Sem mensagens ainda")).toBeTruthy()
  })

  it("folds a group and unfolds it again", () => {
    show()
    expect(screen.getByRole("button", { name: rowName("obraboss-ux") })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Recolher ObraBoss" }))
    expect(screen.queryByRole("button", { name: rowName("obraboss-ux") })).toBeNull()
    expect(screen.getByRole("button", { name: rowName("faturium-dev") })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Expandir ObraBoss" }))
    expect(screen.getByRole("button", { name: rowName("obraboss-ux") })).toBeTruthy()
  })

  it("marks the open Bot (by name or id) and opens a Bot when its row is pressed", () => {
    const onOpen = show(vi.fn(), "obraboss-ux")
    expect(screen.getByRole("button", { name: rowName("obraboss-ux") }).getAttribute("aria-current")).toBe(
      "page",
    )
    expect(
      screen.getByRole("button", { name: rowName("faturium-dev") }).getAttribute("aria-current"),
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: rowName("faturium-dev") }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: FATU, name: "faturium-dev" })
  })

  it("names a row with the Bot, its last message and the time, for screen readers", () => {
    show()
    expect(
      screen.getByRole("button", { name: "obraboss-ux, Decisões registradas em #949, e up..., 14:03" }),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "faturium-dev, Deploy concluído, Ontem" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "seo-desk" })).toBeTruthy()
  })

  it("never lists the Guide", () => {
    show()
    expect(screen.queryByRole("button", { name: rowName("lead") })).toBeNull()
  })
})
