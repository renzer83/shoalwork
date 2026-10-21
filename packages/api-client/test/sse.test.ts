import { describe, expect, it } from "vitest"
import { ApiClient, HttpError, MAX_BUFFER_BYTES, readFrames, subscribeEvents } from "../src/index.js"

const encoder = new TextEncoder()

const streamOf = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

const eventFrame = (position: number): string => {
  const event = {
    id: `evt_00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    position,
    streamId: "task:t",
    version: position,
    type: "error.raised",
    payload: { where: "test", tag: "Boom", message: `m${position}` },
    actor: "system",
    correlationId: "c1",
    occurredAt: "2026-10-21T10:00:00.000Z",
  }
  return `id: ${position}\nevent: error.raised\ndata: ${JSON.stringify(event)}\n\n`
}

const collect = async <A>(
  source: AsyncIterable<A>,
  limit: number,
  abort: AbortController,
): Promise<Array<A>> => {
  const out: Array<A> = []
  for await (const item of source) {
    out.push(item)
    if (out.length >= limit) {
      abort.abort()
    }
  }
  return out
}

describe("readFrames", () => {
  it("splits frames across chunk boundaries and skips pings", async () => {
    const frames = []
    for await (const frame of readFrames(
      streamOf([": ping\n\nid: 1\nevent: a\nda", "ta: one\n\nid: 2\ndata: x\ndata: y\n\n", ": ping\n\n"]),
    )) {
      frames.push(frame)
    }
    expect(frames).toEqual([
      { id: "1", event: "a", data: "one" },
      { id: "2", event: undefined, data: "x\ny" },
    ])
  })

  it("handles CRLF line endings", async () => {
    const frames = []
    for await (const frame of readFrames(streamOf(["id: 7\r\ndata: z\r\n\r\n"]))) {
      frames.push(frame)
    }
    expect(frames).toEqual([{ id: "7", event: undefined, data: "z" }])
  })
})

describe("readFrames limits", () => {
  it("fails with HttpError when one frame grows past the buffer cap", async () => {
    const chunk = `data: ${"x".repeat(64 * 1024)}`
    const chunks = Array.from({ length: MAX_BUFFER_BYTES / chunk.length + 2 }, () => chunk)
    const run = async () => {
      for await (const _frame of readFrames(streamOf(chunks))) {
        // no complete frame ever arrives
      }
    }
    await expect(run()).rejects.toMatchObject({ _tag: "HttpError", status: 0 })
  })

  it("accepts many frames whose total size is above the cap", async () => {
    const frame = `data: ${"y".repeat(32 * 1024)}\n\n`
    const chunks = Array.from({ length: 64 }, () => frame)
    let count = 0
    for await (const _frame of readFrames(streamOf(chunks))) {
      count += 1
    }
    expect(count).toBe(64)
  })
})

describe("subscribeEvents", () => {
  it("yields events, ignores pings, and reconnects with Last-Event-ID", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const bodies = [
      [": ping\n\n", eventFrame(1), eventFrame(2), ": ping\n\n", eventFrame(3)],
      [eventFrame(4)],
    ]
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
      const chunks = bodies[calls.length - 1] ?? []
      return new Response(streamOf(chunks), { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const client = new ApiClient("http://core.test", async () => "tok", fetchImpl)
    const abort = new AbortController()
    const events = await collect(
      subscribeEvents(client, {
        types: ["error.raised"],
        lastEventId: 0,
        signal: abort.signal,
        initialDelayMs: 1,
        maxDelayMs: 2,
      }),
      4,
      abort,
    )
    expect(events.map((event) => event.position)).toEqual([1, 2, 3, 4])
    expect(calls[0]?.url).toBe("http://core.test/events/live?types=error.raised")
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer tok",
      accept: "text/event-stream",
      "last-event-id": "0",
    })
    expect(calls[1]?.headers["last-event-id"]).toBe("3")
  })

  it("reports a frame that does not decode and keeps going", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(streamOf(["id: 1\ndata: {not json\n\n", eventFrame(2)]), { status: 200 })
    const client = new ApiClient("http://core.test", async () => null, fetchImpl)
    const abort = new AbortController()
    const errors: Array<string> = []
    const events = await collect(
      subscribeEvents(client, {
        signal: abort.signal,
        onError: (error) => errors.push(error._tag),
        initialDelayMs: 1,
      }),
      1,
      abort,
    )
    expect(events.map((event) => event.position)).toEqual([2])
    expect(errors).toEqual(["SchemaViolation"])
  })

  it("reports an unreadable token as HttpError status 0", async () => {
    const client = new ApiClient(
      "http://core.test",
      async () => {
        throw new Error("keychain locked")
      },
      async () => new Response("{}"),
    )
    const errors: Array<string> = []
    const abort = new AbortController()
    const run = collect(
      subscribeEvents(client, {
        signal: abort.signal,
        initialDelayMs: 1,
        onError: (e) => errors.push(e._tag),
      }),
      1,
      abort,
    )
    setTimeout(() => abort.abort(), 30)
    await run
    expect(errors[0]).toBe("HttpError")
  })

  it("stops on a 401 instead of retrying", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response("nope", { status: 401 })
    }
    const client = new ApiClient("http://core.test", async () => null, fetchImpl)
    const abort = new AbortController()
    const run = collect(subscribeEvents(client, { signal: abort.signal, initialDelayMs: 1 }), 1, abort)
    await expect(run).rejects.toBeInstanceOf(HttpError)
    expect(calls).toBe(1)
  })

  it("retries after a 503 and resumes", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return calls === 1
        ? new Response("busy", { status: 503 })
        : new Response(streamOf([eventFrame(9)]), { status: 200 })
    }
    const client = new ApiClient("http://core.test", async () => null, fetchImpl)
    const abort = new AbortController()
    const events = await collect(
      subscribeEvents(client, { signal: abort.signal, initialDelayMs: 1 }),
      1,
      abort,
    )
    expect(events.map((event) => event.position)).toEqual([9])
    expect(calls).toBe(2)
  })
})
