import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ApiClient } from "../src/index.js"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const SUMMARY = {
  taskId: "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  state: "done",
  verdict: {
    kind: "ok",
    summary: "s",
    evidence: ["e"],
    cost: { tokensIn: 1, tokensOut: 1, usd: 0.1, seconds: 1 },
  },
  usage: { tokensIn: 1, tokensOut: 1, usd: 0.1, seconds: 1 },
  durationMs: 10,
  executor: "claude-code",
  model: "m",
  files: ["a.ts"],
  evidence: ["e"],
}

describe("replay client", () => {
  it("posts the overrides to the task and decodes the link", async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const client = new ApiClient(
      "http://core.test",
      async () => null,
      async (input, init) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return json(
          {
            replay: {
              id: "rpl_1",
              sourceTaskId: "task_a",
              taskId: "task_b",
              overrides: { executor: "codex" },
              baseSha: null,
              contextFrozen: false,
            },
          },
          201,
        )
      },
    )
    const result = await Effect.runPromise(client.replay.start("task_a", { executor: "codex" }))
    expect(result.replay.taskId).toBe("task_b")
    expect(seen[0]).toEqual({ url: "http://core.test/tasks/task_a/replay", body: { executor: "codex" } })
  })

  it("decodes a comparison and rejects one without a diff", async () => {
    const full = {
      id: "rpl_1",
      sourceTaskId: "task_a",
      newTaskId: "task_b",
      overrides: {},
      baseSha: null,
      contextFrozen: true,
      createdAt: "2026-10-21T10:00:00.000Z",
      source: SUMMARY,
      replay: { ...SUMMARY, verdict: null, state: "running" },
      diff: {
        verdictChanged: false,
        usdDelta: 0,
        durationDeltaMs: 0,
        executorChanged: false,
        modelChanged: false,
        filesOnlyInSource: [],
        filesOnlyInReplay: [],
        evidenceOnlyInSource: [],
        evidenceOnlyInReplay: [],
      },
      notes: [],
    }
    const ok = new ApiClient(
      "http://core.test",
      async () => null,
      async () => json(full),
    )
    expect((await Effect.runPromise(ok.replay.compare("rpl_1"))).replay.verdict).toBeNull()
    const { diff: _omitted, ...broken } = full
    const bad = new ApiClient(
      "http://core.test",
      async () => null,
      async () => json(broken),
    )
    await expect(Effect.runPromise(bad.replay.compare("rpl_1"))).rejects.toThrow()
  })
})
