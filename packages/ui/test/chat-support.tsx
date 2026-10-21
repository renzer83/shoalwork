import { ApiClient } from "@shoalwork/api-client"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { PaperProvider } from "react-native-paper"
import { LocaleProvider, StaticApiProvider, themeFor } from "../src/index.js"

export const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
export const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
export const APPROVAL = "apr_5d1e8f3a-2b7c-4c9d-8e6f-1a2b3c4d5e6f"
export const eventId = (n: number): string => `evt_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const T0 = Date.parse("2026-10-21T10:00:00.000Z")
export const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString()

export const message = (n: number, direction: "in" | "out", text: string, offsetSeconds = n) => ({
  kind: "message",
  position: n,
  occurredAt: iso(offsetSeconds),
  eventId: eventId(n),
  direction,
  channel: direction === "in" ? "app" : "telegram",
  text,
})

export const commandEvent = (position: number, offsetSeconds: number, text: string, exitCode = 0) => ({
  kind: "event",
  position,
  occurredAt: iso(offsetSeconds),
  name: "command",
  taskId: TASK,
  text,
  exitCode,
})

export const fileEvent = (position: number, offsetSeconds: number, text: string) => ({
  kind: "event",
  position,
  occurredAt: iso(offsetSeconds),
  name: "file_edit",
  taskId: TASK,
  text,
})

export const approvalItem = (position: number, status: string, expiresInSeconds = 3600) => ({
  kind: "approval",
  position,
  occurredAt: iso(position),
  approvalId: APPROVAL,
  taskId: TASK,
  botId: BOT,
  tool: "Bash",
  resource: "build/",
  input: '"rm -rf build"',
  risk: "irreversible",
  expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  status,
})

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export interface Call {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

// A core with a scripted /messages and a live feed the test can push frames into.
export function fakeCore(route: (call: Call) => Response | undefined) {
  const calls: Array<Call> = []
  const feeds: Array<ReadableStreamDefaultController<Uint8Array>> = []
  const encoder = new TextEncoder()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    }
    calls.push(call)
    if (url.pathname === "/events/live") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          feeds.push(controller)
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close()
            } catch {
              // already closed
            }
          })
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return route(call) ?? json({ error: "not found" }, 404)
  }
  const push = (position: number, type: string, payload: unknown): void => {
    const frame = `id: ${position}\nevent: ${type}\ndata: ${JSON.stringify({
      id: eventId(position),
      streamId: `bot:${BOT}`,
      version: position,
      position,
      type,
      payload,
      actor: "test",
      correlationId: "corr",
      occurredAt: iso(position),
    })}\n\n`
    for (const feed of feeds) {
      feed.enqueue(encoder.encode(frame))
    }
  }
  return {
    calls,
    push,
    client: new ApiClient("http://core.test", async () => "tok", fetchImpl),
  }
}

export const wrap = (client: ApiClient, ui: ReactNode) => (
  <PaperProvider theme={themeFor("light")}>
    <LocaleProvider locale="en">
      <StaticApiProvider client={client}>{ui}</StaticApiProvider>
    </LocaleProvider>
  </PaperProvider>
)

export const renderWith = (client: ApiClient, ui: ReactNode) => render(wrap(client, ui))
