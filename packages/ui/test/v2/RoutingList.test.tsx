/// <reference lib="dom" />

import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RoutingList } from "../../src/components/v2/settings/RoutingList.js"
import type { RouteEntry } from "../../src/components/v2/settings/settings-model.js"
import { fakeCore, renderPt } from "./support.js"

afterEach(cleanup)

const routes: RouteEntry[] = [
  { executor: "claude-code", model: "claude-haiku-5-5", rule: "always", profile: "quality" },
  { executor: "codex", model: "gpt-5", rule: "fallback", profile: "balanced" },
]

describe("RoutingList", () => {
  it("renders each route entry", () => {
    const core = fakeCore(() => undefined)
    renderPt(core.client, <RoutingList entries={routes} onChange={vi.fn()} />)
    expect(screen.getByText("Claude Haiku 5.5")).toBeTruthy()
    expect(screen.getByText("GPT-5")).toBeTruthy()
  })

  it("tells the screen the user wants to edit a rule", () => {
    const core = fakeCore(() => undefined)
    const onChange = vi.fn()
    renderPt(core.client, <RoutingList entries={routes} onChange={onChange} />)
    const ruleButton = screen.getAllByRole("button", { name: /Regra de/ })[0]
    expect(ruleButton).toBeTruthy()
    if (ruleButton) {
      fireEvent.click(ruleButton)
      const option = screen.getByRole("menuitem", { name: "Fallback se falhar" })
      fireEvent.click(option)
      expect(onChange).toHaveBeenCalled()
    }
  })

  it("tells the screen the user wants to edit a profile", () => {
    const core = fakeCore(() => undefined)
    const onChange = vi.fn()
    renderPt(core.client, <RoutingList entries={routes} onChange={onChange} />)
    const profileButton = screen.getAllByRole("button", { name: /Perfil de/ })[0]
    expect(profileButton).toBeTruthy()
    if (profileButton) {
      fireEvent.click(profileButton)
      const option = screen.getByRole("menuitem", { name: "Velocidade" })
      fireEvent.click(option)
      expect(onChange).toHaveBeenCalled()
    }
  })

  it("reorders entries when the handle receives keyboard arrow navigation", () => {
    const core = fakeCore(() => undefined)
    const onChange = vi.fn()
    renderPt(core.client, <RoutingList entries={routes} onChange={onChange} />)
    const handle = screen.getAllByRole("button", { name: /Reordenar/ })[0]
    expect(handle).toBeTruthy()
    if (handle) {
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(onChange).toHaveBeenCalled()
    }
  })

  it("shows the empty state when there are no routes", () => {
    const core = fakeCore(() => undefined)
    renderPt(core.client, <RoutingList entries={[]} onChange={vi.fn()} />)
    expect(screen.getByText("Nenhum executor conectado para ordenar ainda.")).toBeTruthy()
  })
})
