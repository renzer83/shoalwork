/// <reference lib="dom" />
import { ApiClient } from "@shoalwork/api-client"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { StaticApiProvider } from "../../src/api-context.js"
import { MAX_PREVIEW_PAGES, useBotPreviews } from "../../src/hooks/useBotPreviews.js"
import { commandEvent, eventId, iso, json, LOAD, message, OBRA, page, SOLO } from "./support.js"

afterEach(cleanup)

function Probe({ ids, reconnectMs }: { readonly ids: ReadonlyArray<string>; readonly reconnectMs: number }) {
  const previews = useBotPreviews(ids, { reconnectMs })
  return (
    <pre data-testid="previews">
      {JSON.stringify(Object.fromEntries(Object.entries(previews).map(([id, p]) => [id, p.text])))}
    </pre>
  )
}

const shown = (): Record<string, string> =>
  JSON.parse(screen.getByTestId("previews").textContent ?? "{}") as Record<string, string>

const messagesOf = (url: URL) => ({
  bot: url.searchParams.get("botId") ?? "",
  before: url.searchParams.get("before"),
})

interface Harness {
  readonly client: ApiClient
  readonly timelineCalls: Array<{ bot: string; before: string | null }>
  readonly liveCalls: () => number
}

// A core whose /messages is scripted and whose /events/live answers as the test says, one call at a time.
const harness = (
  timeline: (bot: string, before: string | null, call: number) => unknown,
  live: (call: number) => Response,
): Harness => {
  const timelineCalls: Array<{ bot: string; before: string | null }> = []
  let liveCount = 0
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/events/live") {
      liveCount += 1
      return live(liveCount)
    }
    if (url.pathname === "/messages") {
      const asked = messagesOf(url)
      timelineCalls.push(asked)
      return json(timeline(asked.bot, asked.before, timelineCalls.length))
    }
    return json({ error: "not found" }, 404)
  }
  return {
    client: new ApiClient("http://core.test", async () => "tok", fetchImpl),
    timelineCalls,
    liveCalls: () => liveCount,
  }
}

const idleFeed = (): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const frame = (position: number, type: string, payload: unknown): string =>
  `id: ${position}\nevent: ${type}\ndata: ${JSON.stringify({
    id: eventId(position),
    streamId: `bot:${OBRA}`,
    version: position,
    position,
    type,
    payload,
    actor: "test",
    correlationId: "corr",
    occurredAt: iso(position),
  })}\n\n`

const show = (h: Harness, ids: ReadonlyArray<string>) =>
  render(
    <StaticApiProvider client={h.client}>
      <Probe ids={ids} reconnectMs={20} />
    </StaticApiProvider>,
  )

describe("useBotPreviews", () => {
  it("shows the last message of each Bot", async () => {
    const h = harness(
      (bot) => page(bot, [message(1, "in", "oi"), message(2, "out", `resposta de ${bot.slice(-2)}`)]),
      idleFeed,
    )
    show(h, [OBRA, SOLO])
    await waitFor(() => expect(shown()).toEqual({ [OBRA]: "resposta de a1", [SOLO]: "resposta de a3" }), LOAD)
  })

  it("looks in older pages when the newest one holds no message", async () => {
    const h = harness(
      (bot, before) =>
        before === null
          ? { ...page(bot, [commandEvent(9, 9, "pnpm test")]), nextBefore: 9 }
          : {
              ...page(bot, [message(2, "out", "mensagem antiga"), commandEvent(8, 8, "ls")]),
              nextBefore: null,
            },
      idleFeed,
    )
    show(h, [OBRA])
    await waitFor(() => expect(shown()).toEqual({ [OBRA]: "mensagem antiga" }), LOAD)
    expect(h.timelineCalls).toEqual([
      { bot: OBRA, before: null },
      { bot: OBRA, before: "9" },
    ])
  })

  it("gives up after three pages without a message and shows nothing", async () => {
    const h = harness(
      (bot, before) => ({
        ...page(bot, [commandEvent(50, 50, "ls")]),
        nextBefore: Number(before ?? 100) - 10,
      }),
      idleFeed,
    )
    show(h, [OBRA])
    await waitFor(() => expect(h.timelineCalls).toHaveLength(MAX_PREVIEW_PAGES), LOAD)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.timelineCalls).toHaveLength(MAX_PREVIEW_PAGES)
    expect(shown()).toEqual({})
  })

  it("opens the live feed again, with a pause, after a refusal, and then follows a new message", async () => {
    let answer = "primeira"
    const h = harness(
      (bot) => page(bot, [message(1, "out", answer)]),
      (call) => {
        if (call === 1) return json({ error: "no" }, 401)
        answer = "segunda"
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame(7, "message.outbound", { botId: OBRA })))
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      },
    )
    show(h, [OBRA])
    await waitFor(() => expect(h.liveCalls()).toBeGreaterThanOrEqual(2), LOAD)
    await waitFor(() => expect(shown()).toEqual({ [OBRA]: "segunda" }), LOAD)
  })
})
