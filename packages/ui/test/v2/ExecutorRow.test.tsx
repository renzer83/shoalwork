/// <reference lib="dom" />

import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExecutorRow } from "../../src/components/v2/settings/ExecutorRow.js"
import type { ExecutorSetting } from "../../src/components/v2/settings/settings-model.js"
import { fakeCore, renderPt } from "./support.js"

afterEach(cleanup)

const base = (overrides: Partial<ExecutorSetting> = {}): ExecutorSetting => ({
  id: "claude",
  name: "Claude",
  view: {
    id: "claude",
    ok: true,
    cli: "claude",
    installedVersion: "2.1.304",
    pinnedVersion: "2.1.304",
    status: "ok",
    quota: { executor: "claude", usedRatio: 0.4, available: true },
    quality: [],
    logins: [],
  },
  connected: true,
  enabled: true,
  isDefault: true,
  priority: 1,
  models: [{ id: "claude-4", label: "Claude 4", tags: ["default"] }],
  enabledModels: ["claude-4"],
  mainModel: "claude-4",
  maxTokens: 64_000,
  ...overrides,
})

const defaultProps = (setting: ExecutorSetting) => ({
  setting,
  count: 2,
  selected: false,
  onSelect: vi.fn(),
  onToggle: vi.fn(),
  onPriority: vi.fn(),
  onModel: vi.fn(),
})

describe("ExecutorRow", () => {
  it("renders the executor name and model", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} />)
    expect(screen.getByText("Claude")).toBeTruthy()
    expect(screen.getByText("Claude 4")).toBeTruthy()
  })

  it("shows the connected status", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} />)
    expect(screen.getByText("Conectado")).toBeTruthy()
  })

  it("shows the disconnected status when the doctor failed", () => {
    const core = fakeCore(() => undefined)
    const setting = base({ connected: false })
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} />)
    expect(screen.getByText("Desconectado")).toBeTruthy()
  })

  it("tells the screen the user selected the row", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    const onSelect = vi.fn()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Abrir Claude" }))
    expect(onSelect).toHaveBeenCalledWith("claude")
  })

  it("toggles the executor when the switch is pressed", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    const onToggle = vi.fn()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} onToggle={onToggle} />)
    const switchButton = screen.getByRole("switch", { name: "Habilitar Claude" })
    fireEvent.click(switchButton)
    expect(onToggle).toHaveBeenCalledWith("claude", false)
  })

  it("tells the screen the priority changed", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    const onPriority = vi.fn()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} onPriority={onPriority} />)
    const priorityButton = screen.getByRole("button", { name: /Prioridade de Claude/ })
    fireEvent.click(priorityButton)
    const option = screen.getByRole("menuitem", { name: "Prioridade 2" })
    fireEvent.click(option)
    expect(onPriority).toHaveBeenCalledWith("claude", 2)
  })

  it("tells the screen the model changed", () => {
    const core = fakeCore(() => undefined)
    const setting = base()
    const onModel = vi.fn()
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} onModel={onModel} />)
    const modelButton = screen.getByRole("button", { name: "Claude 4" })
    fireEvent.click(modelButton)
    expect(onModel).toHaveBeenCalledWith("claude", "claude-4")
  })

  it("shows the default badge when the executor is the default", () => {
    const core = fakeCore(() => undefined)
    const setting = base({ isDefault: true })
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} />)
    expect(screen.getByText("Padrão")).toBeTruthy()
  })

  it("does not show the default badge when the executor is not the default", () => {
    const core = fakeCore(() => undefined)
    const setting = base({ isDefault: false })
    renderPt(core.client, <ExecutorRow {...defaultProps(setting)} />)
    expect(screen.queryByText("Padrão")).toBeNull()
  })
})
