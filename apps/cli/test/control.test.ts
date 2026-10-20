import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { controlScope, controlStatus, controlStopTask } from "../src/commands/control.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const TASK_ID = "task_0b0b0b0b-0000-4000-8000-000000000002"
const BOT_ID = "bot_0b0b0b0b-0000-4000-8000-000000000001"

const stubFetch = (body: unknown, status = 200) => {
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("stop, pause and resume", () => {
  it.effect("stop without --bot posts an empty body to /control/stop", () =>
    Effect.gen(function* () {
      const mock = stubFetch({ stopped: [TASK_ID] })
      const result = yield* controlScope(SETTINGS, "stop", {})
      expect(result).toEqual({ stopped: [TASK_ID] })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/control/stop")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(String(init?.body))).toEqual({})
    }),
  )

  it.effect("pause and resume with --bot send the Bot to /control/pause and /control/resume", () =>
    Effect.gen(function* () {
      const mock = stubFetch({ ok: true })
      yield* controlScope(SETTINGS, "pause", { bot: "alpha" })
      yield* controlScope(SETTINGS, "resume", { bot: "alpha" })
      expect(mock.mock.calls.map(([url]) => String(url))).toEqual([
        "http://localhost:28900/control/pause",
        "http://localhost:28900/control/resume",
      ])
      expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toEqual({ bot: "alpha" })
    }),
  )

  it.effect("stop task posts to /tasks/<id>/stop and rejects a malformed id before any request", () =>
    Effect.gen(function* () {
      const mock = stubFetch({ stopped: [TASK_ID] })
      expect(yield* controlStopTask(SETTINGS, TASK_ID)).toEqual({ stopped: [TASK_ID] })
      expect(String(mock.mock.calls[0]?.[0])).toBe(`http://localhost:28900/tasks/${TASK_ID}/stop`)

      const failure = yield* Effect.flip(controlStopTask(SETTINGS, "nope"))
      expect(failure).toBeInstanceOf(UsageError)
      expect(mock.mock.calls).toHaveLength(1)
    }),
  )

  it.effect("an HTTP error from the core comes back as HttpError", () =>
    Effect.gen(function* () {
      stubFetch({ error: "not found" }, 404)
      const failure = yield* Effect.flip(controlScope(SETTINGS, "stop", { bot: "ghost" }))
      expect(failure).toMatchObject({ _tag: "HttpError", status: 404 })
    }),
  )
})

describe("status", () => {
  it.effect("reads GET /control/status", () =>
    Effect.gen(function* () {
      const body = {
        paused: true,
        bots: [{ id: BOT_ID, name: "alpha", state: "paused", paused: true, running: 0 }],
      }
      const mock = stubFetch(body)
      expect(yield* controlStatus(SETTINGS)).toEqual(body)
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/control/status")
    }),
  )

  it.effect("rejects a body that does not match the status shape", () =>
    Effect.gen(function* () {
      stubFetch({ paused: "yes" })
      const failure = yield* Effect.flip(controlStatus(SETTINGS))
      expect(failure._tag).toBe("SchemaViolation")
    }),
  )
})
