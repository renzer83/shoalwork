import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { type NewEvent, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const TASK_ID = Schema.decodeUnknownSync(TaskId)(TASK)
const USAGE = { tokensIn: 1200, tokensOut: 300, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 42 }

// Real SQLite file for the suite; the Beacon is the only service the live feed needs.
const runtime = ManagedRuntime.make(Layer.provideMerge(BeaconLive, withTempDb()))
afterAll(() => runtime.dispose())

const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const stateChanged = (to: "planning" | "running"): NewEvent => ({
  streamId: streamIds.task(TASK_ID),
  type: "task.state_changed",
  payload: { taskId: TASK, from: "received", to },
  actor: "system:watchdog",
  correlationId: "corr_live_test",
})

const usageRecorded = (): NewEvent => ({
  streamId: streamIds.task(TASK_ID),
  type: "usage.recorded",
  payload: {
    taskId: TASK,
    botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
    executor: "claude-code",
    model: "haiku",
    usage: USAGE,
  },
  actor: "bot:bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  correlationId: "corr_live_test",
})

const append = (event: NewEvent) =>
  runEffect(
    Effect.gen(function* () {
      const beacon = yield* Beacon
      return yield* beacon.append(event)
    }).pipe(Effect.orDie),
  )

interface Frame {
  readonly id: string
  readonly event: string
  readonly data: string
}

const decoder = new TextDecoder()

// Comment lines (": ping") carry no id/event/data and are skipped.
const parseFrame = (block: string): Frame | undefined => {
  const fields = new Map<string, string>()
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue
    }
    const separator = line.indexOf(":")
    fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart())
  }
  const id = fields.get("id")
  const event = fields.get("event")
  const data = fields.get("data")
  if (id === undefined || event === undefined || data === undefined) {
    return undefined
  }
  return { id, event, data }
}

// Reads SSE frames from a streamed response body, one frame at a time.
const sseReader = (body: ReadableStream<Uint8Array> | null) => {
  if (body === null) {
    throw new Error("response has no body")
  }
  const reader = body.getReader()
  let buffer = ""
  const next = async (): Promise<Frame | undefined> => {
    let boundary = buffer.indexOf("\n\n")
    while (boundary === -1) {
      const chunk = await reader.read()
      if (chunk.done) {
        return undefined
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      boundary = buffer.indexOf("\n\n")
    }
    const block = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    return parseFrame(block) ?? next()
  }
  return { next, cancel: () => reader.cancel() }
}

describe("GET /", () => {
  it("serves the chat page as text/html without a token and without embedding the token", async () => {
    const res = await app.request("/")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const page = await res.text()
    expect(page).toContain("<title>shoalwork</title>")
    expect(page).not.toContain(TOKEN)
  })
})

describe("GET /events/live", () => {
  it("requires the bearer token, or ?token= on this route only", async () => {
    expect((await app.request("/events/live")).status).toBe(401)
    expect((await app.request("/events/live?token=wrong")).status).toBe(401)
    expect(
      (await app.request(`/tasks/task_00000000-0000-4000-8000-000000000000?token=${TOKEN}`)).status,
    ).toBe(401)

    const res = await app.request(`/events/live?token=${TOKEN}`)
    expect(res.status).toBe(200)
    await res.body?.cancel()
  })

  it("answers text/event-stream and delivers an event appended after the client connects", async () => {
    const res = await app.request("/events/live", { headers: AUTH })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const frames = sseReader(res.body)

    const appended = await append(stateChanged("planning"))
    const frame = await nextWithId(frames, String(appended.position))

    expect(frame.event).toBe("task.state_changed")
    expect(JSON.parse(frame.data)).toMatchObject({ type: "task.state_changed", position: appended.position })
    await frames.cancel()
  })

  it("replays history after Last-Event-ID, then continues with live events", async () => {
    const first = await append(stateChanged("planning"))
    const second = await append(stateChanged("running"))
    const res = await app.request("/events/live", {
      headers: { ...AUTH, "last-event-id": String(first.position) },
    })
    const frames = sseReader(res.body)

    const replayed = await frames.next()
    expect(replayed?.id).toBe(String(second.position))

    const live = await append(usageRecorded())
    const liveFrame = await nextWithId(frames, String(live.position))
    expect(liveFrame.event).toBe("usage.recorded")
    await frames.cancel()
  })

  it("filters by ?types= on history and live events", async () => {
    const before = await append(stateChanged("planning"))
    const usage = await append(usageRecorded())
    await append(stateChanged("running"))
    const res = await app.request("/events/live?types=usage.recorded", {
      headers: { ...AUTH, "last-event-id": String(before.position) },
    })
    const frames = sseReader(res.body)

    const frame = await frames.next()
    expect(frame).toMatchObject({ id: String(usage.position), event: "usage.recorded" })
    await frames.cancel()
  })

  it("answers 400 for an unknown type or an unreadable Last-Event-ID", async () => {
    const badType = await app.request("/events/live?types=nonsense", { headers: AUTH })
    expect(badType.status).toBe(400)
    expect(await badType.json()).toMatchObject({ error: "invalid query", param: "types" })

    const badCursor = await app.request("/events/live", { headers: { ...AUTH, "last-event-id": "abc" } })
    expect(badCursor.status).toBe(400)
    expect(await badCursor.json()).toMatchObject({ error: "invalid header", param: "last-event-id" })
  })
})

// Skips frames that are not the wanted one; a missing frame fails the test by timing out.
const nextWithId = async (frames: ReturnType<typeof sseReader>, id: string): Promise<Frame> => {
  for (;;) {
    const frame = await frames.next()
    if (frame === undefined) {
      throw new Error(`stream ended before event ${id}`)
    }
    if (frame.id === id) {
      return frame
    }
  }
}
