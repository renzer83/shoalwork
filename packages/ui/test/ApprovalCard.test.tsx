/// <reference lib="dom" />
import { TimelineApproval } from "@shoalwork/contracts"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApprovalCard, remaining } from "../src/components/chat/ApprovalCard.js"
import { APPROVAL, approvalItem, BOT, fakeCore, json, renderWith, TASK } from "./chat-support.js"

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

describe("ApprovalCard", () => {
  it("shows the action and risk, sends the decision once and disables both buttons", async () => {
    const core = fakeCore((call) =>
      call.method === "POST" && call.path === `/approvals/${APPROVAL}`
        ? json(resolved("approved"))
        : undefined,
    )
    const onDecided = vi.fn()
    renderWith(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} onDecided={onDecided} />)

    expect(screen.getByText("Bash wants to run")).toBeTruthy()
    expect(screen.getByText('"rm -rf build"')).toBeTruthy()
    expect(screen.getByText("Risk: irreversible")).toBeTruthy()
    expect(isDisabled("Approve")).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith("approved", "user:web"))

    const posts = core.calls.filter((call) => call.method === "POST")
    expect(posts).toEqual([
      { method: "POST", path: `/approvals/${APPROVAL}`, body: { decision: "approved", via: "web" } },
    ])
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Approved by user:web")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  it("sends a denial", async () => {
    const core = fakeCore(() => json(resolved("denied")))
    renderWith(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} />)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    await waitFor(() => expect(screen.getByText("Denied by user:web")).toBeTruthy())
    expect(core.calls.find((call) => call.method === "POST")?.body).toEqual({
      decision: "denied",
      via: "web",
    })
  })

  it("disables the buttons while the request is in flight and re-enables them after a failure", async () => {
    const core = fakeCore(() => json({ error: "boom" }, 500))
    renderWith(core.client, <ApprovalCard item={decode(approvalItem(5, "pending"))} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(isDisabled("Approve")).toBe(true)
    expect(isDisabled("Deny")).toBe(true)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByText("The core answered HTTP 500")).toBeTruthy()
    expect(isDisabled("Approve")).toBe(false)
  })

  it("has no buttons once decided or expired, and counts down while pending", () => {
    const core = fakeCore(() => undefined)
    const { unmount } = renderWith(
      core.client,
      <ApprovalCard item={decode({ ...approvalItem(5, "denied"), resolvedBy: "user:cli" })} />,
    )
    expect(screen.getByText("Denied by user:cli")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull()
    unmount()

    const now = Date.parse("2026-10-21T10:00:00.000Z")
    const item = decode({ ...approvalItem(5, "pending"), expiresAt: "2026-10-21T10:04:32.000Z" })
    renderWith(core.client, <ApprovalCard item={item} now={() => now} />)
    expect(screen.getByText("Waiting for your decision · expires in 4:32")).toBeTruthy()
  })

  it("locks a pending approval whose time ran out", () => {
    const core = fakeCore(() => undefined)
    const item = decode({ ...approvalItem(5, "pending"), expiresAt: "2026-10-21T10:00:00.000Z" })
    renderWith(core.client, <ApprovalCard item={item} now={() => Date.parse("2026-10-21T10:00:05.000Z")} />)
    expect(screen.getByText("Expired")).toBeTruthy()
    expect(isDisabled("Approve")).toBe(true)
  })

  it("formats the remaining time", () => {
    expect(remaining(65_000, 0)).toBe("1:05")
    expect(remaining(1_000, 0)).toBe("0:01")
    expect(remaining(0, 0)).toBeNull()
    expect(remaining(0, 5_000)).toBeNull()
  })
})
