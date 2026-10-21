import { BeaconTest } from "@shoalwork/beacon"
import { nowIso } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { computeMetrics, KanbanLive } from "@shoalwork/factory"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import {
  type BoardTransition,
  boardMetricEvents,
  goalRows,
  type Measures,
} from "../src/http/routes/project-metrics.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" }

const TestLayer = Layer.provideMerge(KanbanLive, Layer.provideMerge(BeaconTest, withTempDb()))
const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

afterAll(() => runtime.dispose())

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T
const get = (path: string) => app.request(path, { headers: AUTH })
const patch = (path: string, body: unknown) =>
  app.request(path, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) })

const T0 = Date.parse("2026-10-21T10:00:00.000Z")
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

describe("boardMetricEvents (pure)", () => {
  it("opens a task at its first transition and closes it at done: lead time is the gap", () => {
    const transitions: ReadonlyArray<BoardTransition> = [
      { taskId: "A", to: "ready", reason: undefined, at: at(0) },
      { taskId: "A", to: "in_progress", reason: undefined, at: at(10) },
      { taskId: "A", to: "in_review", reason: undefined, at: at(20) },
      { taskId: "A", to: "done", reason: undefined, at: at(60) },
    ]

    const metrics = computeMetrics(boardMetricEvents(transitions))

    expect(metrics.leadTimeMedianMs).toBe(3_600_000)
  })

  it("leaves cancelled tasks out of the measures", () => {
    const transitions: ReadonlyArray<BoardTransition> = [
      { taskId: "A", to: "ready", reason: undefined, at: at(0) },
      { taskId: "B", to: "ready", reason: undefined, at: at(1) },
      { taskId: "B", to: "cancelled", reason: undefined, at: at(2) },
    ]

    const events = boardMetricEvents(transitions)

    expect(events.every((event) => event.taskId === "A")).toBe(true)
  })

  it("counts a retry from its reason", () => {
    const transitions: ReadonlyArray<BoardTransition> = [
      { taskId: "A", to: "ready", reason: undefined, at: at(0) },
      { taskId: "A", to: "ready", reason: "retry", at: at(5) },
    ]

    expect(computeMetrics(boardMetricEvents(transitions)).retriesPerTask).toBe(1)
  })
})

describe("goalRows (pure)", () => {
  const current: Measures = {
    lead_time_median_ms: 1_800_000,
    throughput_per_day: 1,
    tokens_per_task: null,
    no_intervention_pct: 95,
    idle_seconds: 90,
    stuck_per_week: 0,
  }

  it("returns the six measures in order, judged against the goals of index.md §2.3", () => {
    const rows = goalRows(current, { lead_time_median_ms: 3_600_000, throughput_per_day: 2 })

    expect(rows.map((row) => row.key)).toEqual([
      "lead_time_median_ms",
      "throughput_per_day",
      "tokens_per_task",
      "no_intervention_pct",
      "idle_seconds",
      "stuck_per_week",
    ])
    expect(rows.map((row) => row.met)).toEqual([true, false, null, true, false, true])
  })

  it("is not met against a missing baseline", () => {
    const rows = goalRows(current, {})

    expect(rows[0]?.met).toBe(false)
    expect(rows[0]?.baseline).toBeNull()
  })
})

interface CompareBody {
  readonly project: string
  readonly baselineAt: string | null
  readonly rows: ReadonlyArray<{
    readonly key: string
    readonly current: number | null
    readonly baseline: number | null
    readonly met: boolean | null
  }>
}

describe("GET /metrics/compare", () => {
  it("answers 400 without a project", async () => {
    const res = await get("/metrics/compare")

    expect(res.status).toBe(400)
  })

  it("answers 200 with six rows and no data for a project without tasks", async () => {
    const res = await get("/metrics/compare?project=nothing-here")

    expect(res.status).toBe(200)
    const body = await json<CompareBody>(res)
    expect(body.rows).toHaveLength(6)
    expect(body.rows.every((row) => row.current === null && row.met === null)).toBe(true)
    expect(body.baselineAt).toBeNull()
  })

  it("compares the board with the latest baseline and counts manual moves as interventions", async () => {
    await post("/projects", "measured")
    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`INSERT INTO project_tasks
          (id, project, title, issue_number, pr_number, state, created_at, retries, manual_interventions, branch, version, updated_at, source)
          VALUES ('ptask_cm_1', 'measured', 'measured', ${null}, ${null}, 'ready', ${nowIso()}, 0, 0, ${null}, 0, ${null}, 'board')`
        yield* sql`INSERT INTO baselines (project, metric, value, window_from, window_to, computed_at)
          VALUES ('measured', 'lead_time_median_ms', 7200000, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
      }),
    )
    await patch("/projects/measured/tasks/ptask_cm_1", { move: { to: "in_progress" } })
    await patch("/projects/measured/tasks/ptask_cm_1", { move: { to: "in_review" } })
    await patch("/projects/measured/tasks/ptask_cm_1", { move: { to: "done" } })

    const body = await json<CompareBody>(await get("/metrics/compare?project=measured"))

    const lead = body.rows.find((row) => row.key === "lead_time_median_ms")
    expect(lead?.baseline).toBe(7_200_000)
    expect(lead?.current).not.toBeNull()
    expect(lead?.met).toBe(true)
    expect(body.rows.find((row) => row.key === "no_intervention_pct")?.current).toBe(0)
    expect(body.rows.find((row) => row.key === "no_intervention_pct")?.met).toBe(false)
    expect(body.baselineAt).toBe("2026-10-01T00:00:00.000Z")
  })
})

// Creates a project through the API so the compare test can move its task.
const post = (path: string, slug: string) =>
  app.request(path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      slug,
      name: slug,
      repoUrl: `https://github.com/x/${slug}`,
      defaultBranch: "main",
    }),
  })
