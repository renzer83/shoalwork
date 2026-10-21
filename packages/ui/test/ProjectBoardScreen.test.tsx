import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectBoardScreen, themeFor } from "../src/index.js"
import { renderWith } from "./chat-support.js"

const EVENT_ID = "evt_00000000-0000-4000-8000-000000000001"
const PROJECT = {
  slug: "gamma",
  name: "Gamma",
  repoUrl: "https://github.com/x/gamma",
  defaultBranch: "main",
  status: "active",
  maxInProgress: 3,
  autoMerge: false,
}

interface FakeTask {
  id: string
  project: string
  title: string
  issueNumber: number | null
  prNumber: number | null
  state: string
  branch: string | null
  retries: number
  manualInterventions: number
  version: number
  updatedAt: string | null
  sprintId: string | null
}

const task = (id: string, title: string, state: string): FakeTask => ({
  id,
  project: "gamma",
  title,
  issueNumber: null,
  prNumber: null,
  state,
  branch: null,
  retries: 0,
  manualInterventions: 0,
  version: 0,
  updatedAt: "2026-10-21T10:00:00.000Z",
  sprintId: null,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const METRICS = {
  project: "gamma",
  baselineAt: null,
  rows: [
    {
      key: "lead_time_median_ms",
      label: "Lead time (median)",
      target: "≤ 50% of baseline",
      current: null,
      baseline: null,
      met: null,
    },
    {
      key: "throughput_per_day",
      label: "Throughput per day",
      target: "≥ 3× baseline",
      current: null,
      baseline: null,
      met: null,
    },
    {
      key: "tokens_per_task",
      label: "Tokens per task",
      target: "≤ 60% of baseline",
      current: null,
      baseline: null,
      met: null,
    },
    {
      key: "no_intervention_pct",
      label: "Tasks without manual intervention",
      target: "≥ 90%",
      current: null,
      baseline: null,
      met: null,
    },
    {
      key: "idle_seconds",
      label: "Idle per transition",
      target: "< 60 s",
      current: null,
      baseline: null,
      met: null,
    },
    {
      key: "stuck_per_week",
      label: "Stuck tasks (> 1 h) per week",
      target: "0",
      current: null,
      baseline: null,
      met: null,
    },
  ],
}

// A scripted core: the board's reads, the PATCH actions (the machine refuses ready -> done), and a live feed.
function fakeBoard(tasks: Array<FakeTask>) {
  const feeds: Array<ReadableStreamDefaultController<Uint8Array>> = []
  const encoder = new TextEncoder()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path === "/events/live") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          feeds.push(controller)
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close()
            } catch {
              // already closed
            }
          })
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/projects") return json({ projects: [PROJECT] })
    if (path === "/projects/gamma/tasks") return json({ tasks })
    if (path === "/projects/gamma/sprints") return json({ sprints: [] })
    if (path === "/metrics/compare") return json(METRICS)
    if (init?.method === "PATCH" && path.startsWith("/projects/gamma/tasks/")) {
      const id = path.split("/").pop() ?? ""
      const found = tasks.find((t) => t.id === id)
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as { move?: { to: string } }) : {}
      if (found === undefined) return json({ error: "not found" }, 404)
      if (body.move?.to === "done") {
        return json({ error: "conflict", reason: `invalid transition ${found.state} -> done` }, 409)
      }
      const updated: FakeTask = { ...found, state: body.move?.to ?? found.state, version: found.version + 1 }
      tasks.splice(tasks.indexOf(found), 1, updated)
      return json({ task: updated })
    }
    return json({ error: "not found" }, 404)
  }
  const push = (type: string, payload: unknown): void => {
    const frame = `id: 1\nevent: ${type}\ndata: ${JSON.stringify({
      id: EVENT_ID,
      streamId: "project:gamma",
      version: 1,
      position: 1,
      type,
      payload,
      actor: "test",
      correlationId: "corr",
      occurredAt: "2026-10-21T12:00:00.000Z",
    })}\n\n`
    for (const feed of feeds) feed.enqueue(encoder.encode(frame))
  }
  return { client: new ApiClient("http://core.test", async () => "tok", fetchImpl), push, feeds }
}

const show = (client: ApiClient) => renderWith(client, <ProjectBoardScreen slug="gamma" />)

afterEach(cleanup)

describe("ProjectBoardScreen", () => {
  it("places each task in the column of its state", async () => {
    const board = fakeBoard([
      task("ptask_1", "Fix login", "ready"),
      task("ptask_2", "Write docs", "in_progress"),
    ])
    show(board.client)

    await waitFor(() => expect(screen.getByLabelText("column ready")).toBeTruthy())
    expect(within(screen.getByLabelText("column ready")).getByText("Fix login")).toBeTruthy()
    expect(within(screen.getByLabelText("column in_progress")).getByText("Write docs")).toBeTruthy()
  })

  it("shows the reason of a refused transition and does not move the card", async () => {
    const board = fakeBoard([task("ptask_1", "Fix login", "ready")])
    show(board.client)
    await waitFor(() => expect(screen.getByLabelText("column ready")).toBeTruthy())
    const ready = within(screen.getByLabelText("column ready"))
    await waitFor(() => expect(ready.getByText("Fix login")).toBeTruthy())

    fireEvent.click(ready.getByText("Move"))
    fireEvent.click(ready.getByText("done"))

    await waitFor(() => expect(screen.getByText("Refused: invalid transition ready -> done")).toBeTruthy())
    expect(within(screen.getByLabelText("column ready")).getByText("Fix login")).toBeTruthy()
    expect(within(screen.getByLabelText("column done")).queryByText("Fix login")).toBeNull()
  })

  it("moves the card when project_task.state_changed arrives over SSE", async () => {
    const board = fakeBoard([task("ptask_1", "Fix login", "ready")])
    show(board.client)
    await waitFor(() => expect(screen.getByLabelText("column ready")).toBeTruthy())
    await waitFor(() => expect(board.feeds.length).toBeGreaterThan(0))

    board.push("project_task.state_changed", {
      project: "gamma",
      taskId: "ptask_1",
      from: "ready",
      to: "in_progress",
    })

    await waitFor(() =>
      expect(within(screen.getByLabelText("column in_progress")).getByText("Fix login")).toBeTruthy(),
    )
    expect(within(screen.getByLabelText("column ready")).queryByText("Fix login")).toBeNull()
    expect(themeFor).toBeDefined()
  })
})
