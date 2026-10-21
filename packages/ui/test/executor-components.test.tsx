import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { gaugeTone, sortQuality } from "../src/components/executor/executor-model.js"
import { LoginStatus } from "../src/components/executor/LoginStatus.js"
import { QualityTable } from "../src/components/executor/QualityTable.js"
import { QuotaGauge } from "../src/components/executor/QuotaGauge.js"
import { LocaleProvider, themeFor } from "../src/index.js"

const theme = themeFor("light")
const wrap = (node: ReactNode) => (
  <PaperProvider theme={theme}>
    <LocaleProvider locale="pt-BR">{node}</LocaleProvider>
  </PaperProvider>
)

afterEach(cleanup)

describe("gaugeTone", () => {
  it("turns to alert from 0.8 of the window used, and not before", () => {
    expect(gaugeTone(0.79)).toBe("normal")
    expect(gaugeTone(0.8)).toBe("alert")
    expect(gaugeTone(1)).toBe("alert")
  })
})

describe("QuotaGauge", () => {
  it("draws the fill in the error colour from 80% and says so in words", () => {
    const alert = render(wrap(<QuotaGauge usedRatio={0.85} available />))
    const alertColor = getComputedStyle(screen.getByTestId("quota-fill")).backgroundColor
    expect(screen.getByText("Atenção: 85% da janela já usados")).toBeTruthy()
    alert.unmount()
    render(wrap(<QuotaGauge usedRatio={0.5} available />))
    const normalColor = getComputedStyle(screen.getByTestId("quota-fill")).backgroundColor
    expect(alertColor).not.toBe("")
    expect(alertColor).not.toBe(normalColor)
  })

  it("keeps the primary colour and no alert below 80%", () => {
    render(wrap(<QuotaGauge usedRatio={0.5} available />))
    expect(screen.queryByText(/Atenção/)).toBeNull()
    expect(screen.getByText("Cota usada: 50%")).toBeTruthy()
  })
})

describe("LoginStatus", () => {
  it("never renders a string that looks like a credential, only state and method", () => {
    render(
      wrap(
        <LoginStatus
          logins={[
            {
              botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
              authMethod: "claude.ai",
              state: "logged_in",
            },
            { botId: "bot_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", authMethod: null, state: "logged_out" },
          ]}
        />,
      ),
    )
    expect(screen.getByText(/sem login$/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sk-|token|secret/i)
  })

  it("says so when no login applies to the executor", () => {
    render(wrap(<LoginStatus logins={[]} />))
    expect(screen.getByText("Sem login a verificar para este executor")).toBeTruthy()
  })
})

describe("QualityTable", () => {
  const rows = [
    { kind: "chat", okRate: 0.5, n: 10, avgUsd: 0.01 },
    { kind: "code", okRate: 0.75, n: 4, avgUsd: 0.02 },
  ]
  const order = (): Array<string | null> =>
    screen.getAllByText(/execuções/).map((element) => element.textContent?.split(" · ")[0] ?? null)

  it("starts by the number of runs, most first, and reverses on a second press of the header", () => {
    render(wrap(<QualityTable rows={rows} />))
    expect(order()).toEqual(["chat", "code"])
    fireEvent.click(screen.getByRole("button", { name: /Execuções/ }))
    expect(order()).toEqual(["code", "chat"])
  })

  it("sorts by the success rate when its header is pressed", () => {
    render(wrap(<QualityTable rows={rows} />))
    fireEvent.click(screen.getByRole("button", { name: "Sucesso" }))
    expect(order()).toEqual(["code", "chat"])
  })

  it("says there are no runs in the window when the rows are empty", () => {
    render(wrap(<QualityTable rows={[]} />))
    expect(screen.getByText("Sem execuções nos últimos 30 dias")).toBeTruthy()
  })
})

describe("sortQuality", () => {
  it("keeps the input untouched and orders the kinds alphabetically when asked", () => {
    const rows = [
      { kind: "research", okRate: 1, n: 1, avgUsd: 0 },
      { kind: "code", okRate: 0, n: 2, avgUsd: 0 },
    ]
    expect(sortQuality(rows, "kind", "asc").map((row) => row.kind)).toEqual(["code", "research"])
    expect(rows.map((row) => row.kind)).toEqual(["research", "code"])
  })
})
