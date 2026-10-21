/// <reference lib="dom" />
import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ChatScreen } from "../src/index.js"
import {
  APPROVAL,
  approvalItem,
  BOT,
  commandEvent,
  fakeCore,
  fileEvent,
  iso,
  json,
  message,
  renderWith,
  TASK,
  wrap,
} from "./chat-support.js"

afterEach(cleanup)

const page = (items: ReadonlyArray<unknown>, nextBefore: number | null = null, head = 40) => ({
  botId: BOT,
  items,
  nextBefore,
  head,
})

describe("ChatScreen", () => {
  it("renders messages as plain text, folds commands and edits into one chip, and shows approval and artifact", async () => {
    const hostile = '<img src=x onerror="alert(1)"> **not bold**'
    const items = [
      message(1, "in", "oi lead"),
      message(2, "out", hostile),
      commandEvent(3, 3, "pnpm test"),
      commandEvent(4, 5, "pnpm lint", 1),
      fileEvent(5, 8, "src/a.ts"),
      approvalItem(6, "pending"),
      {
        kind: "artifact",
        position: 7,
        occurredAt: iso(30),
        taskId: TASK,
        artifactKind: "pr",
        ref: "https://example.test/pr/1",
        summary: "Fix the thing",
      },
      {
        kind: "event",
        position: 8,
        occurredAt: iso(31),
        name: "finished",
        taskId: TASK,
        verdict: "ok",
        text: "all done",
      },
    ]
    const core = fakeCore((call) => (call.path.startsWith("/messages?") ? json(page(items)) : undefined))
    const { container } = renderWith(core.client, <ChatScreen bot="lead" />)

    await waitFor(() => expect(screen.getByText("oi lead")).toBeTruthy())
    expect(screen.getByText(hostile)).toBeTruthy()
    expect(container.querySelector("img")).toBeNull()
    expect(screen.getByText("2 commands (1 failed), 1 file edited · src/a.ts")).toBeTruthy()
    expect(screen.getByText("Bash wants to run")).toBeTruthy()
    expect(screen.getByText("Fix the thing")).toBeTruthy()
    expect(screen.getByText("https://example.test/pr/1")).toBeTruthy()
    expect(screen.getByText("Run finished (ok) · all done")).toBeTruthy()
    expect(core.calls[0]?.path).toBe("/messages?botId=lead&limit=50")
  })

  it("sends the typed text to POST /messages, clears the field and pulls what is new", async () => {
    let delivered = false
    const core = fakeCore((call) => {
      if (call.method === "POST" && call.path === "/messages") {
        delivered = true
        return json({ eventId: "evt_00000000-0000-4000-8000-000000000099" }, 202)
      }
      if (call.path.startsWith("/messages?")) {
        return json(page(delivered ? [message(1, "in", "oi")] : []))
      }
      return undefined
    })
    renderWith(core.client, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByText("No messages yet")).toBeTruthy())

    const input = screen.getByLabelText("Message")
    fireEvent.change(input, { target: { value: "oi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => expect(screen.getByText(/oi/, { selector: "div" })).toBeTruthy())
    const posts = core.calls.filter((call) => call.method === "POST")
    expect(posts).toEqual([{ method: "POST", path: "/messages", body: { botId: "lead", text: "oi" } }])
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("")
    expect(core.calls.some((call) => call.path.includes("after="))).toBe(true)
  })

  it("keeps the text and shows the error when the core refuses the message", async () => {
    const core = fakeCore((call) =>
      call.method === "POST" ? json({ error: "not found" }, 404) : json(page([])),
    )
    renderWith(core.client, <ChatScreen bot="nobody" />)
    await waitFor(() => expect(screen.getByText("No messages yet")).toBeTruthy())
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "oi" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(screen.getByText("That Bot does not exist")).toBeTruthy())
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("oi")
  })

  it("follows the live feed: a new message is fetched and a decided approval closes its card", async () => {
    let answered = false
    const core = fakeCore((call) => {
      if (!call.path.startsWith("/messages?")) return undefined
      if (call.path.includes("after=")) {
        return json(page(answered ? [message(41, "out", "here I am")] : [], null, 41))
      }
      return json(page([message(1, "in", "oi"), approvalItem(2, "pending")]))
    })
    renderWith(core.client, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy())
    await waitFor(() =>
      expect(
        core.calls.some(
          (call) =>
            call.path ===
            "/events/live?types=message.inbound,message.outbound,task.state_changed,executor.event,executor.finished,approval.requested,approval.resolved",
        ),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(core.calls.filter((call) => call.path.startsWith("/events/live")).length).toBe(1),
    )

    answered = true
    core.push(41, "message.outbound", { channel: "telegram", botId: BOT, text: "here I am" })
    await waitFor(() => expect(screen.getByText("here I am")).toBeTruthy())

    core.push(42, "approval.resolved", { approvalId: APPROVAL, decision: "denied", by: "user:telegram:1" })
    await waitFor(() => expect(screen.getByText("Denied by user:telegram:1")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  it("loads older pages with the before cursor", async () => {
    const core = fakeCore((call) => {
      if (call.path.includes("before=")) return json(page([message(1, "in", "first of all")], null))
      if (call.path.startsWith("/messages?")) return json(page([message(10, "in", "newest")], 10))
      return undefined
    })
    renderWith(core.client, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByText("newest")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }))
    await waitFor(() => expect(screen.getByText("first of all")).toBeTruthy())
    expect(core.calls.some((call) => call.path === "/messages?botId=lead&before=10&limit=50")).toBe(true)
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull()
  })

  it("shows an error banner when the core is unreachable", async () => {
    const core = fakeCore(() => undefined)
    const broken = new (core.client.constructor as typeof import("@shoalwork/api-client").ApiClient)(
      "http://core.test",
      async () => null,
      async () => {
        throw new TypeError("fetch failed")
      },
    )
    renderWith(broken, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByText("Cannot reach the core at http://core.test")).toBeTruthy())
  })

  it("drops the previous Bot's items and ignores its late older page when the Bot changes", async () => {
    let releaseOlder: () => void = () => undefined
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const core = fakeCore((call) => {
      if (call.path.includes("botId=alpha") && call.path.includes("before=")) {
        return undefined
      }
      if (call.path.startsWith("/messages?botId=alpha"))
        return json(page([message(10, "in", "alpha newest")], 10))
      if (call.path.startsWith("/messages?botId=beta")) return json(page([message(20, "in", "beta only")]))
      return undefined
    })
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes("botId=alpha") && String(input).includes("before=")) {
        await olderGate
        return json(page([message(1, "in", "alpha old")]))
      }
      return core.client.fetchImpl(input, init)
    }
    const client = new ApiClient("http://core.test", async () => null, slow)
    const view = renderWith(client, <ChatScreen bot="alpha" />)
    await waitFor(() => expect(screen.getByText("alpha newest")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }))

    view.rerender(wrap(client, <ChatScreen bot="beta" />))
    await waitFor(() => expect(screen.getByText("beta only")).toBeTruthy())
    expect(screen.queryByText("alpha newest")).toBeNull()
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull()

    releaseOlder()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("alpha old")).toBeNull()
    expect(screen.getByText("beta only")).toBeTruthy()
  })

  it("ignores live events about another Bot but still refreshes on task state changes", async () => {
    const core = fakeCore((call) =>
      call.path.includes("after=")
        ? json(page([], null, 50))
        : call.path.startsWith("/messages?")
          ? json(page([message(1, "in", "oi")]))
          : undefined,
    )
    renderWith(core.client, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByText("oi")).toBeTruthy())
    await waitFor(() =>
      expect(core.calls.filter((call) => call.path.startsWith("/events/live")).length).toBe(1),
    )

    const deltas = () => core.calls.filter((call) => call.path.includes("after=")).length
    core.push(50, "message.outbound", {
      channel: "telegram",
      botId: "bot_00000000-0000-4000-8000-000000000000",
      text: "not for you",
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(deltas()).toBe(0)

    core.push(51, "task.state_changed", { taskId: TASK, from: "ready", to: "running" })
    await waitFor(() => expect(deltas()).toBe(1))
  })

  it("shows a live error when pulling what is new fails, and keeps working afterwards", async () => {
    let failing = true
    const core = fakeCore((call) => {
      if (call.path.includes("after="))
        return failing ? json({ error: "boom" }, 500) : json(page([message(41, "out", "back")], null, 41))
      return call.path.startsWith("/messages?") ? json(page([message(1, "in", "oi")])) : undefined
    })
    renderWith(core.client, <ChatScreen bot="lead" />)
    await waitFor(() => expect(screen.getByText("oi")).toBeTruthy())
    await waitFor(() =>
      expect(core.calls.filter((call) => call.path.startsWith("/events/live")).length).toBe(1),
    )
    core.push(41, "message.outbound", { channel: "telegram", botId: BOT, text: "back" })
    await waitFor(() =>
      expect(screen.getByText("Live updates paused: The core answered HTTP 500")).toBeTruthy(),
    )

    failing = false
    core.push(42, "message.outbound", { channel: "telegram", botId: BOT, text: "back" })
    await waitFor(() => expect(screen.getByText("back")).toBeTruthy())
  })
})
