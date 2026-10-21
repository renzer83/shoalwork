import { Event, type TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { baseShaOf, diffOf, type RunSummary } from "../src/replay-compare.js"

const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" as TaskId
const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const SHA = "0123456789abcdef0123456789abcdef01234567"

const started = (position: number, baseSha: string) =>
  Schema.decodeUnknownSync(Event)({
    id: `evt_4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c${position.toString().padStart(2, "0")}`,
    version: position,
    position,
    occurredAt: "2026-10-21T12:00:00.000Z",
    streamId: `task:${TASK}`,
    type: "executor.started",
    payload: { taskId: TASK, botId: BOT, executor: "claude-code", model: "m", cwd: "/w", baseSha },
    actor: "system:lead",
    correlationId: TASK,
  })

const summary = (over: Partial<RunSummary>): RunSummary => ({
  taskId: TASK,
  state: "done",
  verdict: {
    kind: "ok",
    summary: "s",
    evidence: [],
    cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
  },
  usage: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
  durationMs: 0,
  executor: "claude-code",
  model: "m",
  files: [],
  evidence: [],
  ...over,
})

describe("baseShaOf", () => {
  it("takes the first recorded base commit", () => {
    expect(baseShaOf([started(1, SHA), started(2, "f".repeat(40))])).toBe(SHA)
  })

  it("ignores a base that is not a commit hash (the log is data)", () => {
    expect(baseShaOf([started(1, "--orphan")])).toBeUndefined()
  })
})

describe("diffOf", () => {
  it("does not call a verdict changed while the replay has none", () => {
    expect(diffOf(summary({}), summary({ verdict: null, state: "running" })).verdictChanged).toBe(false)
  })

  it("lists the evidence and files only one side has, and the deltas", () => {
    const diff = diffOf(
      summary({
        files: ["a"],
        evidence: ["x", "y"],
        model: "m1",
        usage: { tokensIn: 0, tokensOut: 0, usd: 1, seconds: 0 },
        durationMs: 100,
      }),
      summary({
        files: ["b"],
        evidence: ["y", "z"],
        model: "m2",
        usage: { tokensIn: 0, tokensOut: 0, usd: 3, seconds: 0 },
        durationMs: 40,
      }),
    )
    expect(diff).toMatchObject({
      filesOnlyInSource: ["a"],
      filesOnlyInReplay: ["b"],
      evidenceOnlyInSource: ["x"],
      evidenceOnlyInReplay: ["z"],
      modelChanged: true,
      executorChanged: false,
      usdDelta: 2,
      durationDeltaMs: -60,
    })
  })
})
