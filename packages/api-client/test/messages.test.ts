import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { ApiClient, getTimeline, sendMessage } from "../src/index.js"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const clientWith = (answer: () => Response) => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init })
    return answer()
  }
  return { seen, client: new ApiClient("http://core.test", async () => "secret", fetchImpl) }
}

describe("chat routes", () => {
  it.effect("decodes a timeline page and builds the query", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() =>
        json({
          items: [
            {
              kind: "message",
              position: 3,
              occurredAt: "2026-10-21T10:00:00.000Z",
              eventId: "evt_00000000-0000-4000-8000-000000000001",
              direction: "in",
              channel: "app",
              text: "oi",
            },
          ],
          botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
          nextBefore: 3,
          head: 9,
        }),
      )
      const page = yield* getTimeline(client, "lead", { before: 7, limit: 20 })
      expect(page.items[0]).toMatchObject({ kind: "message", text: "oi" })
      expect(page.nextBefore).toBe(3)
      expect(seen[0]?.url).toBe("http://core.test/messages?botId=lead&before=7&limit=20")
      expect(seen[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" })
    }),
  )

  it.effect("rejects an item of an unknown kind", () =>
    Effect.gen(function* () {
      const { client } = clientWith(() =>
        json({
          botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
          items: [{ kind: "html", body: "<b>" }],
          nextBefore: null,
          head: 1,
        }),
      )
      const result = yield* Effect.result(getTimeline(client, "lead"))
      expect(result._tag).toBe("Failure")
    }),
  )

  it.effect("posts the text to /messages", () =>
    Effect.gen(function* () {
      const { client, seen } = clientWith(() => json({ eventId: "evt_x" }, 202))
      const accepted = yield* sendMessage(client, "lead", "oi")
      expect(accepted.eventId).toBe("evt_x")
      expect(seen[0]?.init?.method).toBe("POST")
      expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ botId: "lead", text: "oi" })
    }),
  )
})
