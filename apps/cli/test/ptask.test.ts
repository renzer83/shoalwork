import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { ptaskMove, ptaskRetry } from "../src/commands/ptask.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }

const TASK = {
  id: "ptask_1",
  project: "faturium",
  title: "task ptask_1",
  issueNumber: 1,
  prNumber: null,
  state: "in_progress",
  branch: null,
  retries: 0,
  manualInterventions: 0,
  version: 1,
  updatedAt: null,
}

const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const sentBody = (mock: ReturnType<typeof stubFetch>): Record<string, unknown> =>
  JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ptask move", () => {
  it.effect("posts the target state to the move route and decodes the task", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK }))

      const moved = yield* ptaskMove(SETTINGS, "faturium", "ptask_1", "in_progress", undefined)

      expect(moved.state).toBe("in_progress")
      expect(String(mock.mock.calls[0]?.[0])).toBe(
        "http://localhost:28900/projects/faturium/tasks/ptask_1/move",
      )
      expect(sentBody(mock)).toEqual({ to: "in_progress" })
    }),
  )

  it.effect("sends the reason when it is given", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK }))

      yield* ptaskMove(SETTINGS, "faturium", "ptask_1", "blocked", "paused")

      expect(sentBody(mock)).toEqual({ to: "blocked", reason: "paused" })
    }),
  )

  it.effect("rejects an unknown state before any request", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK }))

      const error = yield* Effect.flip(ptaskMove(SETTINGS, "faturium", "ptask_1", "exploded", undefined))

      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )
})

describe("ptask retry", () => {
  it.effect("posts to the retry route and decodes the task", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: { ...TASK, state: "ready", retries: 1 } }))

      const moved = yield* ptaskRetry(SETTINGS, "faturium", "ptask_1")

      expect(moved).toMatchObject({ state: "ready", retries: 1 })
      expect(String(mock.mock.calls[0]?.[0])).toBe(
        "http://localhost:28900/projects/faturium/tasks/ptask_1/retry",
      )
      expect(mock.mock.calls[0]?.[1]?.method).toBe("POST")
    }),
  )
})
