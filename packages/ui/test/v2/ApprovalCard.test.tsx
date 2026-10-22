/// <reference lib="dom" />
import { TimelineApproval } from "@shoalwork/contracts"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApprovalCard } from "../../src/components/v2/chat/ApprovalCard.js"
import { APPROVAL, approvalItem, BOT, fakeCore, json, LOAD, renderPt, TASK } from "./support.js"

afterEach(cleanup)

const decode = (raw: unknown) => Schema.decodeUnknownSync(TimelineApproval)(raw)

const resolved = (status: string) => ({
  result: "resolved",
  approval: {
    id: APPROVAL,
    taskId: TASK,
    botId: BOT,
    action: { tool: "Bash", input: "rm -rf build" },
    risk: "irreversible",
    status,
    requestedAt: "2026-10-21T10:00:00.000Z",
    expiresAt: "2026-10-21T11:00:00.000Z",
    resolvedAt: "2026-10-21T10:01:00.000Z",
    resolvedBy: "user:web",
  },
})

const isDisabled = (name: string): boolean =>
  screen.getByRole("button", { name }).getAttribute("aria-disabled") === "true"

describe("v2 ApprovalCard", () => {
  it("Aprovar calls approvals.resolve once and the card closes with who decided", async () => {
    const core = fakeCore((call) =>
      call.method === "POST" && call.path === `/approvals/${APPROVAL}`
        ? json(resolved("approved"))
        : undefined,
    )
    const onDecided = vi.fn()
    renderPt(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} onDecided={onDecided} />)

    expect(screen.getByText("Solicitação de aprovação")).toBeTruthy()
    expect(screen.getByText("Risco: irreversible")).toBeTruthy()
    expect(isDisabled("Aprovar")).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("approved", "user:web"), LOAD)

    expect(core.calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: `/approvals/${APPROVAL}`, body: { decision: "approved", via: "web" } },
    ])
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Revisar" })).toBeNull()
  })

  it("Revisar sends the request back as a denial", async () => {
    const core = fakeCore(() => json(resolved("denied")))
    renderPt(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} />)
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revisar" })).toBeNull(), LOAD)
    expect(core.calls.find((call) => call.method === "POST")?.body).toEqual({
      decision: "denied",
      via: "web",
    })
  })

  it("tells Revisar apart from Aprovar by icon and by an accessible hint", () => {
    renderPt(fakeCore(() => undefined).client, <ApprovalCard item={decode(approvalItem(5, "pending"))} />)
    const iconPath = (name: string): string | null | undefined =>
      screen.getByRole("button", { name }).querySelector("path")?.getAttribute("d")
    expect(iconPath("Aprovar")).not.toBe(iconPath("Revisar"))
    const review = screen.getByRole("button", { name: "Revisar" })
    const hintId = review.getAttribute("aria-describedby")
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId ?? "")?.textContent).toBe("Devolve o pedido sem aprová-lo")
  })

  it("locks both buttons while sending and shows a failure without losing the buttons", async () => {
    const core = fakeCore(() => json({ error: "boom" }, 500))
    renderPt(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} />)
    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
    expect(isDisabled("Aprovar")).toBe(true)
    expect(isDisabled("Revisar")).toBe(true)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy(), LOAD)
    expect(isDisabled("Aprovar")).toBe(false)
  })

  it("has no buttons once decided or expired, and counts down while pending", () => {
    const core = fakeCore(() => undefined)
    const { unmount } = renderPt(
      core.client,
      <ApprovalCard item={decode({ ...approvalItem(5, "denied"), resolvedBy: "user:cli" })} />,
    )
    expect(screen.getByText("Negado por user:cli")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
    unmount()

    const now = Date.parse("2026-10-21T10:00:00.000Z")
    const item = decode({ ...approvalItem(5, "pending"), expiresAt: "2026-10-21T10:04:32.000Z" })
    renderPt(core.client, <ApprovalCard item={item} now={() => now} />)
    expect(screen.getByText("Aguardando sua decisão · expira em 4:32")).toBeTruthy()
  })

  it("locks a pending approval whose time ran out", () => {
    const core = fakeCore(() => undefined)
    const item = decode({ ...approvalItem(5, "pending"), expiresAt: "2026-10-21T10:00:00.000Z" })
    renderPt(core.client, <ApprovalCard item={item} now={() => Date.parse("2026-10-21T10:00:05.000Z")} />)
    expect(screen.getByText("Expirado")).toBeTruthy()
    expect(isDisabled("Aprovar")).toBe(true)
  })
})
