import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { parseArgs, UsageError } from "../src/args.js"
import { eventsList } from "../src/commands/events.js"
import { taskSend, taskShow } from "../src/commands/task.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const BOT_ID = "bot_0b0b0b0b-0000-4000-8000-000000000001"
const TASK_ID = "task_0b0b0b0b-0000-4000-8000-000000000002"

const FLAGS = {
  bot: BOT_ID,
  prompt: "reply with the single word pong",
  kind: "chat",
  tier: "light",
}

const TASK_SPEC = {
  id: TASK_ID,
  botId: BOT_ID,
  title: "reply",
  prompt: "reply with the single word pong",
  kind: "chat",
  acceptance: [],
  budget: { tokens: 200000, seconds: 1800, usd: 2 },
  tier: "light",
  origin: "cli",
}

// Replaces global fetch for one test; the mock is returned so the request can be inspected.
const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const sentBody = (mock: ReturnType<typeof stubFetch>): Record<string, unknown> => {
  const init = mock.mock.calls[0]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("task send", () => {
  it.effect("posts the spec with the defaults and prints the task id from the response", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK_SPEC }, 201))

      const created = yield* taskSend(SETTINGS, FLAGS)

      expect(created).toEqual({ taskId: TASK_ID })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/tasks")
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dev-token")
      expect(sentBody(mock)).toEqual({
        botId: BOT_ID,
        title: "reply with the single word pong",
        prompt: "reply with the single word pong",
        kind: "chat",
        acceptance: [],
        budget: { tokens: 200000, seconds: 1800, usd: 2 },
        tier: "light",
        origin: "cli",
      })
    }),
  )

  it.effect("sends the repo with base main when only --repo is given", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK_SPEC }, 201))

      yield* taskSend(SETTINGS, { ...FLAGS, repo: "https://github.com/acme/sandbox" })

      expect(sentBody(mock).repo).toEqual({ url: "https://github.com/acme/sandbox", base: "main" })
    }),
  )

  it.effect("keeps a prompt that looks like a flag as plain data", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK_SPEC }, 201))
      const prompt = "--permission-mode=bypassPermissions -x"

      const parsed = yield* parseArgs(["--bot", BOT_ID, "--prompt", prompt], ["bot", "prompt"])
      yield* taskSend(SETTINGS, parsed.flags)

      expect(sentBody(mock).prompt).toBe(prompt)
    }),
  )

  it.effect("resolves a bot name through GET /bots and posts the id it finds", () =>
    Effect.gen(function* () {
      const mock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
        String(input).endsWith("/bots")
          ? json({ bots: [{ id: BOT_ID, name: "lead", role: "coordinator", state: "idle" }] })
          : json({ task: TASK_SPEC }, 201),
      )
      vi.stubGlobal("fetch", mock)

      const created = yield* taskSend(SETTINGS, { ...FLAGS, bot: "lead" })

      expect(created).toEqual({ taskId: TASK_ID })
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/bots")
      expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer dev-token")
      const post = JSON.parse(String(mock.mock.calls[1]?.[1]?.body)) as { botId: string }
      expect(post.botId).toBe(BOT_ID)
    }),
  )

  it.effect("reports an unknown bot name and never posts a task", () =>
    Effect.gen(function* () {
      const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        json({ bots: [{ id: BOT_ID, name: "lead", role: "coordinator", state: "idle" }] }),
      )
      vi.stubGlobal("fetch", mock)

      const error = yield* Effect.flip(taskSend(SETTINGS, { ...FLAGS, bot: "ghost" }))

      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toBe("unknown bot name: ghost")
      expect(mock).toHaveBeenCalledTimes(1)
    }),
  )

  it.effect("requires --prompt", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK_SPEC }, 201))

      const error = yield* Effect.flip(taskSend(SETTINGS, { bot: BOT_ID }))

      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )

  it.effect("rejects an unknown kind through the task schema before any request", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ task: TASK_SPEC }, 201))

      const error = yield* Effect.flip(taskSend(SETTINGS, { ...FLAGS, kind: "nonsense" }))

      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toMatch(/invalid task/)
      expect(mock).not.toHaveBeenCalled()
    }),
  )

  it.effect("rejects --base without --repo", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(taskSend(SETTINGS, { ...FLAGS, base: "dev" }))

      expect(error).toBeInstanceOf(UsageError)
    }),
  )
})

describe("task show", () => {
  it.effect("reads GET /tasks/:id with the bearer token and decodes the view", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ spec: TASK_SPEC, state: "done", verdict: undefined }))

      const view = yield* taskShow(SETTINGS, TASK_ID)

      expect(view.state).toBe("done")
      expect(view.spec.id).toBe(TASK_ID)
      expect(String(mock.mock.calls[0]?.[0])).toBe(`http://localhost:28900/tasks/${TASK_ID}`)
    }),
  )

  it.effect("rejects a value that is not a task id before any request", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ spec: TASK_SPEC, state: "done" }))

      const error = yield* Effect.flip(taskShow(SETTINGS, "not-an-id"))

      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )

  it.effect("reports a response that does not match the view as SchemaViolation", () =>
    Effect.gen(function* () {
      stubFetch(async () => json({ spec: TASK_SPEC, state: "exploded" }))

      const error = yield* Effect.flip(taskShow(SETTINGS, TASK_ID))

      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )
})

describe("events", () => {
  it.effect("reads the stream from --after with the query built from the flags", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ events: [] }))

      const body = yield* eventsList(SETTINGS, { stream: `task:${TASK_ID}`, after: "3" })

      expect(body.events).toEqual([])
      const url = new URL(String(mock.mock.calls[0]?.[0]))
      expect(url.pathname).toBe("/events")
      expect(url.searchParams.get("stream")).toBe(`task:${TASK_ID}`)
      expect(url.searchParams.get("after")).toBe("3")
    }),
  )

  it.effect("defaults --after to 0", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ events: [] }))

      yield* eventsList(SETTINGS, { stream: "system" })

      expect(new URL(String(mock.mock.calls[0]?.[0])).searchParams.get("after")).toBe("0")
    }),
  )

  it.effect("requires --stream and a non-negative integer --after", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ events: [] }))

      const missing = yield* Effect.flip(eventsList(SETTINGS, {}))
      const negative = yield* Effect.flip(eventsList(SETTINGS, { stream: "system", after: "-1" }))

      expect(missing).toBeInstanceOf(UsageError)
      expect(negative).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )
})

describe("parseArgs", () => {
  it.effect("rejects a flag the command does not declare", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseArgs(["--nope", "x"], ["bot"]))

      expect(error).toBeInstanceOf(UsageError)
    }),
  )

  it.effect("collects positional arguments next to flags", () =>
    Effect.gen(function* () {
      const parsed = yield* parseArgs([TASK_ID, "--url", "http://x"], ["url"])

      expect(parsed.positionals).toEqual([TASK_ID])
      expect(parsed.flags).toEqual({ url: "http://x" })
    }),
  )
})
