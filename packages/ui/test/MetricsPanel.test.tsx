import { cleanup, render, screen } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { MetricsPanel, themeFor } from "../src/index.js"

afterEach(cleanup)

const rows = [
  {
    key: "lead_time_median_ms",
    label: "Lead time (median)",
    target: "≤ 50% of baseline",
    current: 1_800_000,
    baseline: 3_600_000,
    met: true,
  },
  {
    key: "throughput_per_day",
    label: "Throughput per day",
    target: "≥ 3× baseline",
    current: 1,
    baseline: 2,
    met: false,
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
    current: 95,
    baseline: null,
    met: true,
  },
  {
    key: "idle_seconds",
    label: "Idle per transition",
    target: "< 60 s",
    current: 90,
    baseline: null,
    met: false,
  },
  {
    key: "stuck_per_week",
    label: "Stuck tasks (> 1 h) per week",
    target: "0",
    current: 0,
    baseline: null,
    met: true,
  },
]

const show = (load: Parameters<typeof MetricsPanel>[0]["load"]) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <MetricsPanel load={load} onRetry={() => undefined} />
    </PaperProvider>,
  )

describe("MetricsPanel", () => {
  it("renders the six measures, each with its goal verdict", () => {
    show({ kind: "loaded", value: { project: "gamma", baselineAt: "2026-10-01T00:00:00.000Z", rows } })

    expect(screen.getAllByLabelText(/^(goal met|goal missed|no data): /)).toHaveLength(6)
    expect(screen.getByLabelText("goal met: Lead time (median)")).toBeTruthy()
    expect(screen.getByLabelText("goal missed: Throughput per day")).toBeTruthy()
    expect(screen.getByLabelText("no data: Tokens per task")).toBeTruthy()
    expect(screen.getByLabelText("goal missed: Idle per transition")).toBeTruthy()
    expect(screen.getByText("30.0 min")).toBeTruthy()
  })

  it("says so when the project has no baseline yet", () => {
    show({ kind: "loaded", value: { project: "gamma", baselineAt: null, rows } })

    expect(screen.getByText("No baseline computed for this project")).toBeTruthy()
  })
})
