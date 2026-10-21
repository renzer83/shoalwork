import type { PodDetail } from "@shoalwork/api-client"
import { Event } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { reactTo } from "../src/hooks/pod-model.js"

const TASK_1 = "task_10000000-0000-4000-8000-000000000001"
const TASK_2 = "task_10000000-0000-4000-8000-000000000002"
const UNKNOWN = "task_10000000-0000-4000-8000-000000000009"

const detail: PodDetail = {
  pod: {
    id: "pod_66666666-7777-4888-8999-aaaaaaaaaaaa",
    taskId: "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    name: "pod-0a1b2c",
    state: "open",
    threadId: 7,
    botIds: [],
    createdAt: "2026-10-21T10:00:00.000Z",
    closedAt: null,
  },
  plan: null,
  steps: [
    {
      id: "s1",
      title: "Um",
      state: "running",
      botId: null,
      dependsOn: [],
      taskId: TASK_1,
      usage: { usd: 0.01, tokensIn: 1, tokensOut: 1 },
    },
    {
      id: "s2",
      title: "Dois",
      state: "pending",
      botId: null,
      dependsOn: ["s1"],
      taskId: TASK_2,
      usage: { usd: 0, tokensIn: 0, tokensOut: 0 },
    },
  ],
  messages: [],
}

const event = (type: string, payload: unknown) =>
  Schema.decodeUnknownSync(Event)({
    id: "evt_00000000-0000-4000-8000-000000000001",
    streamId: `task:${TASK_1}`,
    version: 1,
    position: 1,
    type,
    payload,
    actor: "test",
    correlationId: "corr",
    occurredAt: "2026-10-21T10:00:00.000Z",
  })

describe("reactTo", () => {
  it("recolours the step of a task whose state changed", () => {
    const reaction = reactTo(
      detail,
      event("task.state_changed", { taskId: TASK_1, from: "running", to: "done" }),
    )
    expect(reaction.kind).toBe("patched")
    if (reaction.kind === "patched") expect(reaction.detail.steps[0]?.state).toBe("done")
  })

  it("adds a usage record to the step of its task", () => {
    const usage = { tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0, usd: 0.02, seconds: 2 }
    const reaction = reactTo(
      detail,
      event("usage.recorded", {
        taskId: TASK_1,
        botId: "bot_00000000-0000-4000-8000-0000000000a1",
        executor: "claude-code",
        model: "m",
        usage,
      }),
    )
    expect(reaction.kind).toBe("patched")
    if (reaction.kind === "patched") expect(reaction.detail.steps[0]?.usage.usd).toBeCloseTo(0.03)
  })

  it("asks for a refetch when the task is not a step of this Pod", () => {
    expect(
      reactTo(detail, event("task.state_changed", { taskId: UNKNOWN, from: "ready", to: "running" })),
    ).toEqual({
      kind: "refresh",
    })
  })

  it("ignores a payload that does not decode", () => {
    expect(reactTo(detail, event("task.state_changed", { nope: true }))).toEqual({ kind: "ignore" })
  })
})
