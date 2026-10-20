import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  collectStream,
  evaluateSoak,
  findOrphans,
  formatReport,
  isExecutorCommand,
  isInWindow,
  isStaleStopped,
  PAGE_SIZE,
  type ProcessRow,
  parseBotIds,
  parseEventPage,
  parseHealth,
  parsePs,
  REQUIRED_UPTIME_SECONDS,
  runSoak,
  type SoakEvent,
  type SoakFacts,
  type SoakFetch,
  WINDOW_MS,
} from "../soak-check.js"

const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const inside = new Date(NOW - 60 * 60 * 1000).toISOString()
const outside = new Date(NOW - WINDOW_MS - 1000).toISOString()
const scriptPath = fileURLToPath(new URL("../soak-check.ts", import.meta.url))

const event = (overrides: Partial<SoakEvent> & { readonly type: string }): SoakEvent => ({
  version: 1,
  occurredAt: inside,
  payload: {},
  ...overrides,
})

const staleStopped = (occurredAt: string = inside): SoakEvent =>
  event({
    type: "watchdog.recovered",
    occurredAt,
    payload: { what: "stale_task", ref: "task_1", action: "stopped" },
  })

const healthy: SoakFacts = {
  nowMs: NOW,
  baseUrl: "http://127.0.0.1:28900",
  uptimeSeconds: REQUIRED_UPTIME_SECONDS + 10,
  staleStopped: 0,
  errorRaised: 2,
  budgetExceeded: 0,
  streamsRead: ["system"],
  orphans: { corePids: [100], executorCount: 1, orphanPids: [] },
  problems: [],
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("pure parsers", () => {
  it("accepts a health body and rejects one without uptimeSeconds", () => {
    expect(parseHealth({ ok: true, uptimeSeconds: 5, version: "0.0.0" })).toEqual({
      ok: true,
      uptimeSeconds: 5,
    })
    expect(parseHealth({ ok: true })).toBe("health.uptimeSeconds is missing")
  })

  it("accepts a bots body and rejects a bot without id", () => {
    expect(parseBotIds({ bots: [{ id: "bot_1" }, { id: "bot_2" }] })).toEqual(["bot_1", "bot_2"])
    expect(parseBotIds({ bots: [{ name: "lead" }] })).toBe("a bot has no id")
  })

  it("accepts an events page and rejects an event without version", () => {
    const page = parseEventPage({
      events: [{ type: "error.raised", version: 3, occurredAt: inside, payload: {}, streamId: "system" }],
    })
    expect(page).toEqual([{ type: "error.raised", version: 3, occurredAt: inside, payload: {} }])
    expect(parseEventPage({ events: [{ type: "error.raised", occurredAt: inside, payload: {} }] })).toBe(
      "an event lacks version",
    )
  })
})

describe("window and watchdog criterion", () => {
  it("counts only events inside the last 48 h", () => {
    expect(isInWindow(event({ type: "error.raised", occurredAt: inside }), NOW)).toBe(true)
    expect(isInWindow(event({ type: "error.raised", occurredAt: outside }), NOW)).toBe(false)
  })

  it("matches only watchdog stale_task recoveries with action stopped", () => {
    expect(isStaleStopped(staleStopped())).toBe(true)
    expect(
      isStaleStopped(
        event({
          type: "watchdog.recovered",
          payload: { what: "stale_task", ref: "task_1", action: "retried" },
        }),
      ),
    ).toBe(false)
    expect(
      isStaleStopped(
        event({ type: "watchdog.recovered", payload: { what: "long_process", ref: "p", action: "stopped" } }),
      ),
    ).toBe(false)
    expect(
      isStaleStopped(event({ type: "error.raised", payload: { what: "stale_task", action: "stopped" } })),
    ).toBe(false)
  })
})

describe("collectStream", () => {
  it("pages with after = last version until a short page comes back", async () => {
    const calls: number[] = []
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, index) =>
      event({ type: "error.raised", version: index + 1 }),
    )
    const tail = [501, 502, 503].map((version) => event({ type: "error.raised", version }))
    const readPage = async (_streamId: string, after: number): Promise<ReadonlyArray<SoakEvent>> => {
      calls.push(after)
      return after === 0 ? fullPage : tail
    }
    const events = await collectStream(readPage, "system")
    expect(calls).toEqual([0, PAGE_SIZE])
    expect(events).toHaveLength(PAGE_SIZE + 3)
  })

  it("fails instead of looping when the server does not advance", async () => {
    const stuck = Array.from({ length: PAGE_SIZE }, () => event({ type: "error.raised", version: 1 }))
    await expect(collectStream(async () => stuck, "system")).rejects.toThrow(/did not advance/)
  })
})

describe("process table", () => {
  const sample = [
    "  100     1 /usr/local/bin/node /srv/shoalwork/services/core/dist/main.js",
    "  200   100 /home/bot/.local/bin/claude -p --output-format stream-json --verbose -- hello",
    "  300     1 /home/bot/.local/bin/claude -p --output-format stream-json -- hi",
    "  400     1 vim notes.txt",
    "",
  ].join("\n")

  it("parses ps output into pid, ppid and command", () => {
    expect(parsePs(sample)[0]).toEqual({
      pid: 100,
      ppid: 1,
      command: "/usr/local/bin/node /srv/shoalwork/services/core/dist/main.js",
    })
    expect(parsePs(sample)).toHaveLength(4)
  })

  it("recognises non-interactive claude and codex executors only", () => {
    expect(isExecutorCommand("/home/bot/.local/bin/claude -p --output-format stream-json")).toBe(true)
    expect(
      isExecutorCommand(
        "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --input-format stream-json",
      ),
    ).toBe(true)
    expect(isExecutorCommand("codex exec --json -- fix the bug")).toBe(true)
    expect(isExecutorCommand("/home/me/.local/bin/claude")).toBe(false)
    expect(isExecutorCommand("codex")).toBe(false)
    expect(isExecutorCommand("vim claude.txt")).toBe(false)
  })

  it("flags an executor whose ancestors do not include the core", () => {
    const rows: ReadonlyArray<ProcessRow> = parsePs(sample)
    const report = findOrphans(rows)
    expect(report.corePids).toEqual([100])
    expect(report.executorCount).toBe(2)
    expect(report.orphanPids).toEqual([300])
  })

  it("accepts an executor reached through an intermediate shell under the core", () => {
    const rows = parsePs(
      [
        "  100     1 node /srv/shoalwork/services/core/dist/main.js",
        "  150   100 /bin/sh -c something",
        "  200   150 codex exec --json -- task",
      ].join("\n"),
    )
    expect(findOrphans(rows).orphanPids).toEqual([])
  })
})

describe("evaluateSoak", () => {
  it("passes when uptime, watchdog and orphan criteria hold", () => {
    const result = evaluateSoak(healthy)
    expect(result.pass).toBe(true)
    expect(result.checks.every((check) => check.pass)).toBe(true)
  })

  it("fails below 48 h of core uptime", () => {
    const result = evaluateSoak({ ...healthy, uptimeSeconds: REQUIRED_UPTIME_SECONDS - 1 })
    expect(result.pass).toBe(false)
    expect(result.checks[0]?.pass).toBe(false)
  })

  it("fails on any stopped stale task in the window", () => {
    expect(evaluateSoak({ ...healthy, staleStopped: 1 }).pass).toBe(false)
  })

  it("fails when an executor has no core parent, naming its pid", () => {
    const result = evaluateSoak({
      ...healthy,
      orphans: { corePids: [100], executorCount: 1, orphanPids: [300] },
    })
    expect(result.pass).toBe(false)
    expect(result.checks[2]?.detail).toContain("pids 300")
  })

  it("fails when the core process cannot be found, instead of assuming there are no orphans", () => {
    expect(
      evaluateSoak({ ...healthy, orphans: { corePids: [], executorCount: 0, orphanPids: [] } }).pass,
    ).toBe(false)
  })

  it("fails when any input could not be read", () => {
    expect(evaluateSoak({ ...healthy, problems: ["GET /bots returned HTTP 401"] }).pass).toBe(false)
    expect(evaluateSoak({ ...healthy, orphans: undefined }).pass).toBe(false)
  })

  it("keeps error.raised and budget.exceeded informational", () => {
    expect(evaluateSoak({ ...healthy, errorRaised: 99, budgetExceeded: 9 }).pass).toBe(true)
  })
})

describe("runSoak", () => {
  const TOKEN = "test-token-value"

  const fakeCore = (options: {
    readonly events: Record<string, ReadonlyArray<SoakEvent>>
    readonly uptime: number
  }) => {
    const seen: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
    const fetchImpl: SoakFetch = async (url, init) => {
      const headers = new Headers(init.headers)
      seen.push({ url, authorization: headers.get("authorization") ?? undefined })
      const parsed = new URL(url)
      if (parsed.pathname === "/health") {
        return jsonResponse(200, { ok: true, version: "0.0.0", db: "ok", uptimeSeconds: options.uptime })
      }
      if (headers.get("authorization") !== `Bearer ${TOKEN}`)
        return jsonResponse(401, { error: "unauthorized" })
      if (parsed.pathname === "/bots") return jsonResponse(200, { bots: [{ id: "bot_a" }] })
      if (parsed.pathname === "/events") {
        const stream = parsed.searchParams.get("stream") ?? ""
        const after = Number(parsed.searchParams.get("after") ?? 0)
        const events = (options.events[stream] ?? []).filter((item) => item.version > after)
        return jsonResponse(200, { events: events.map((item) => ({ ...item, streamId: stream })) })
      }
      return jsonResponse(404, { error: "not found" })
    }
    return { fetchImpl, seen }
  }

  const noProcesses = async (): Promise<ReadonlyArray<ProcessRow>> => [
    { pid: 100, ppid: 1, command: "node /srv/shoalwork/services/core/dist/main.js" },
  ]

  it("reads every stream the core reports and fails on a stopped stale task", async () => {
    const core = fakeCore({
      uptime: REQUIRED_UPTIME_SECONDS + 5,
      events: { system: [staleStopped()], "bot:bot_a": [event({ type: "budget.exceeded", version: 1 })] },
    })
    const { facts, result } = await runSoak(
      { baseUrl: "http://core.test", token: TOKEN },
      { fetchImpl: core.fetchImpl, listProcesses: noProcesses, nowMs: () => NOW },
    )
    expect(facts.staleStopped).toBe(1)
    expect(facts.budgetExceeded).toBe(1)
    expect(facts.streamsRead).toEqual(["system", "bot:bot_a"])
    expect(result.pass).toBe(false)
    const eventCalls = core.seen.filter((call) => call.url.includes("/events?"))
    expect(
      eventCalls.every((call) =>
        call.url.includes("types=watchdog.recovered%2Cerror.raised%2Cbudget.exceeded"),
      ),
    ).toBe(true)
  })

  it("passes on a clean core and never prints the token", async () => {
    const core = fakeCore({ uptime: REQUIRED_UPTIME_SECONDS + 5, events: {} })
    const { facts, result } = await runSoak(
      { baseUrl: "http://core.test", token: TOKEN },
      { fetchImpl: core.fetchImpl, listProcesses: noProcesses, nowMs: () => NOW },
    )
    expect(result.pass).toBe(true)
    expect(formatReport(facts, result)).not.toContain(TOKEN)
    expect(formatReport(facts, result)).toContain("RESULT: PASS")
  })

  it("reports a rejected token as a problem, without a stack trace", async () => {
    const core = fakeCore({ uptime: 10, events: {} })
    const { facts, result } = await runSoak(
      { baseUrl: "http://core.test", token: "wrong" },
      { fetchImpl: core.fetchImpl, listProcesses: noProcesses, nowMs: () => NOW },
    )
    expect(result.pass).toBe(false)
    expect(facts.problems).toContain("GET /bots returned HTTP 401")
    expect(formatReport(facts, result)).not.toContain("    at ")
  })
})

describe("soak:check CLI", () => {
  it("exits 1 with a FAIL report when no core answers, without a stack trace", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, APP_URL: "http://127.0.0.1:9", API_TOKEN: "" },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("RESULT: FAIL")
    expect(result.stdout).toContain("GET /health failed")
    expect(`${result.stdout}${result.stderr}`).not.toContain("    at ")
  })
})
