import { NewBot } from "@shoalwork/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Schema } from "effect"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotForm } from "../src/components/bot/BotForm.js"
import { type BotDraft, draftOf, validateDraft } from "../src/components/bot/bot-form-model.js"
import { themeFor } from "../src/index.js"

const VALID = Schema.decodeUnknownSync(NewBot)({
  name: "reviewer",
  role: "checker",
  kind: "auxiliary",
  instructions: "Review the diff and answer briefly.",
  executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 300000, seconds: 900, usd: 3 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const draft = (over: Partial<BotDraft> = {}): BotDraft => ({ ...draftOf(VALID), ...over })

afterEach(cleanup)

describe("bot form validation (the NewBot schema)", () => {
  it("accepts the valid ficha", () => {
    expect(validateDraft(draft()).ok).toBe(true)
  })

  it("puts a bad name on the name field", () => {
    const result = validateDraft(draft({ name: "Bad Name!" }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.name).toBeTruthy()
  })

  it("puts a non-numeric budget on its own field", () => {
    const result = validateDraft(draft({ tokens: "lots" }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.tokens).toBeTruthy()
  })
})

describe("BotForm", () => {
  it("rejects an invalid name before anything is sent", () => {
    const onSubmit = vi.fn()
    render(
      <PaperProvider theme={themeFor("light")}>
        <BotForm initial={draftOf(VALID)} onSubmit={onSubmit} />
      </PaperProvider>,
    )
    fireEvent.change(screen.getByDisplayValue("reviewer"), { target: { value: "Bad Name!" } })
    fireEvent.click(screen.getByText("Save"))
    expect(onSubmit).not.toHaveBeenCalled()
    // The schema message names the pattern; the error sits under the Name field.
    expect(screen.getByText(/matching the RegExp/)).toBeTruthy()
  })

  it("sends the validated bot when the ficha is valid", () => {
    const onSubmit = vi.fn()
    render(
      <PaperProvider theme={themeFor("light")}>
        <BotForm initial={draftOf(VALID)} onSubmit={onSubmit} />
      </PaperProvider>,
    )
    fireEvent.click(screen.getByText("Save"))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ name: "reviewer", role: "checker" })
  })
})
