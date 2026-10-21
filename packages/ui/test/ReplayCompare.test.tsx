import { ApiClient, type ReplayComparison } from "@shoalwork/api-client"
import { ExecutorId } from "@shoalwork/contracts"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { ReplayCompare } from "../src/components/beacon/ReplayCompare.js"
import { BeaconScreen, LocaleProvider, StaticApiProvider, themeFor } from "../src/index.js"

const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const NEW_TASK = "task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"

const run = (over: Partial<ReplayComparison["source"]> = {}): ReplayComparison["source"] => ({
  taskId: TASK,
  state: "done",
  verdict: {
    kind: "ok",
    summary: "done",
    evidence: ["tests pass"],
    cost: { tokensIn: 1, tokensOut: 1, usd: 0.1, seconds: 1 },
  },
  usage: { tokensIn: 100, tokensOut: 50, usd: 0.1, seconds: 4 },
  durationMs: 4000,
  executor: "claude-code",
  model: "opus",
  files: ["a.ts", "b.ts"],
  evidence: ["tests pass"],
  ...over,
})

const comparison = (over: Partial<ReplayComparison> = {}): ReplayComparison => ({
  id: "rpl_1",
  sourceTaskId: TASK,
  newTaskId: NEW_TASK,
  overrides: { executor: Schema.decodeUnknownSync(ExecutorId)("codex") },
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  contextFrozen: true,
  createdAt: "2026-10-21T10:00:00.000Z",
  source: run(),
  replay: run({
    taskId: NEW_TASK,
    verdict: {
      kind: "failed",
      summary: "no",
      evidence: ["tests fail"],
      cost: { tokensIn: 1, tokensOut: 1, usd: 0.35, seconds: 9 },
    },
    usage: { tokensIn: 200, tokensOut: 90, usd: 0.35, seconds: 9 },
    durationMs: 9000,
    executor: "codex",
    model: "gpt-test-1",
    files: ["b.ts", "c.ts"],
    evidence: ["tests fail"],
  }),
  diff: {
    verdictChanged: true,
    usdDelta: 0.25,
    durationDeltaMs: 5000,
    executorChanged: true,
    modelChanged: true,
    filesOnlyInSource: ["a.ts"],
    filesOnlyInReplay: ["c.ts"],
    evidenceOnlyInSource: ["tests pass"],
    evidenceOnlyInReplay: ["tests fail"],
  },
  notes: [],
  ...over,
})

const inTheme = (children: React.ReactNode) => (
  <PaperProvider theme={themeFor("light")}>
    <LocaleProvider locale="pt-BR">{children}</LocaleProvider>
  </PaperProvider>
)

afterEach(cleanup)

// Each wait is bounded on its own: findBy's default 1 s is shorter than a render on a slow runner.
const WAIT = { timeout: 4_000 }

describe("ReplayCompare", () => {
  it("shows both runs side by side with what changed", async () => {
    render(inTheme(<ReplayCompare comparison={comparison()} />))

    expect(await screen.findByText("ok", {}, WAIT)).toBeTruthy()
    expect(screen.getByText("failed")).toBeTruthy()
    expect(screen.getByText("US$ 0.1000")).toBeTruthy()
    expect(screen.getByText("US$ 0.3500")).toBeTruthy()
    expect(screen.getByText("claude-code")).toBeTruthy()
    expect(screen.getByText("codex")).toBeTruthy()
    expect(screen.getByText(/O veredito mudou · custo \+US\$ 0\.2500 · tempo 5\.0 s/)).toBeTruthy()
    expect(screen.getByText("a.ts")).toBeTruthy()
    expect(screen.getByText("c.ts")).toBeTruthy()
    expect(screen.getByText(/Overrides: executor=codex/)).toBeTruthy()
    expect(screen.getByText(/Base: 0123456789ab · Contexto: congelado/)).toBeTruthy()
  })

  it("says the replay is still running when it has no verdict yet", async () => {
    const running = comparison({
      replay: run({ taskId: NEW_TASK, verdict: null, state: "running", evidence: [] }),
    })
    render(inTheme(<ReplayCompare comparison={running} />))

    expect(await screen.findByText("O replay ainda não terminou.", {}, WAIT)).toBeTruthy()
    expect(screen.getByText("sem veredito (running)")).toBeTruthy()
  })

  it("prints log text as text: markup in a file name or a note is not rendered", async () => {
    const hostile = comparison({
      notes: ["<img src=x onerror=alert(1)>"],
      diff: { ...comparison().diff, filesOnlyInReplay: ["<script>alert(1)</script>"] },
    })
    const { container } = render(inTheme(<ReplayCompare comparison={hostile} />))

    expect(await screen.findByText("<script>alert(1)</script>", {}, WAIT)).toBeTruthy()
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
  })

  it("calls back to refresh and to close", async () => {
    const calls: Array<string> = []
    render(
      inTheme(
        <ReplayCompare
          comparison={comparison()}
          onRefresh={() => calls.push("refresh")}
          onClose={() => calls.push("close")}
        />,
      ),
    )

    fireEvent.click(await screen.findByRole("button", { name: "Atualizar comparação" }, WAIT))
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }))

    expect(calls).toEqual(["refresh", "close"])
  })
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const taskEvent = {
  id: "evt_00000000-0000-4000-8000-000000000007",
  streamId: `task:${TASK}`,
  version: 3,
  position: 7,
  type: "executor.finished",
  payload: { verdict: { kind: "ok" } },
  actor: "system:test",
  correlationId: TASK,
  occurredAt: "2026-10-21T10:00:00.000Z",
}
const botEvent = {
  ...taskEvent,
  id: "evt_00000000-0000-4000-8000-000000000008",
  position: 8,
  streamId: "bot:bot_x",
  type: "bot.updated",
}

const SAVINGS = {
  decisions: { total: 0, rule: 0, cache: 0, model: 0, localPct: null },
  haikuRuns: 0,
  decisionUsd: null,
  avoidedUsd: null,
  context: {
    assembled: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensCut: 0,
    cutPct: null,
    droppedItems: 0,
    usdPerInputToken: null,
    avoidedUsd: null,
  },
}

// A fake core for the Farol with the replay routes: the comparison only exists after the POST.
const core = (seen: Array<string>, refuse = false): typeof fetch => {
  return async (input, init) => {
    const url = new URL(String(input))
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`)
    if (url.pathname === "/beacon/savings") return json(SAVINGS)
    if (url.pathname === "/beacon/costs/daily") return json({ days: [] })
    if (url.pathname === "/beacon/costs")
      return json({ rows: [], delta: { tokensInPct: null, okRatePct: null } })
    if (url.pathname === "/beacon/events") return json({ events: [botEvent, taskEvent], nextBefore: null })
    if (url.pathname === `/tasks/${TASK}/replay`) {
      if (refuse) return json({ error: "invalid request" }, 400)
      return json(
        {
          replay: {
            id: "rpl_1",
            sourceTaskId: TASK,
            taskId: NEW_TASK,
            overrides: {},
            baseSha: null,
            contextFrozen: true,
          },
        },
        201,
      )
    }
    if (url.pathname === "/replays/rpl_1") return json(comparison({ overrides: {} }))
    return json({ error: "not found" }, 404)
  }
}

const showFarol = (seen: Array<string>, refuse = false) =>
  render(
    inTheme(
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, core(seen, refuse))}>
        <BeaconScreen />
      </StaticApiProvider>,
    ),
  )

describe("Replay from the Farol", () => {
  it("offers Replay only on an event of a task stream", async () => {
    showFarol([])

    fireEvent.click(await screen.findByRole("button", { name: /bot\.updated/ }, WAIT))
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: /executor\.finished/ }, WAIT))
    expect(await screen.findByRole("button", { name: "Replay" }, WAIT)).toBeTruthy()
  })

  it("starts the replay of the selected task and shows the comparison", async () => {
    const seen: Array<string> = []
    showFarol(seen)

    fireEvent.click(await screen.findByRole("button", { name: /executor\.finished/ }, WAIT))
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }, WAIT))

    expect(await screen.findByLabelText("Comparação do replay", {}, WAIT)).toBeTruthy()
    expect(await screen.findByText("failed", {}, WAIT)).toBeTruthy()
    expect(seen).toContain(`POST /tasks/${TASK}/replay`)
    expect(seen).toContain("GET /replays/rpl_1")
    fireEvent.click(await screen.findByRole("button", { name: "Fechar" }, WAIT))
    await waitFor(() => expect(screen.queryByLabelText("Comparação do replay")).toBeNull(), WAIT)
  })

  it("shows why the core refused the replay", async () => {
    showFarol([], true)

    fireEvent.click(await screen.findByRole("button", { name: /executor\.finished/ }, WAIT))
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }, WAIT))

    expect(await screen.findByText(/O replay foi recusado/, {}, WAIT)).toBeTruthy()
  })
})
