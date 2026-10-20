import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted } from "effect"
import { describe, expect } from "vitest"
import { TelegramLive } from "../../src/telegram/index.js"
import { ALLOWED_USER, FORUM_CHAT, TestLayer, TOKEN } from "../support.js"

// Local Bot API stand-in on 127.0.0.1: records method names, answers like Telegram would. No internet.
interface FakeServer {
  readonly url: string
  readonly methods: Array<string>
  readonly server: Server
}

const BOT_USER = { id: 42, is_bot: true, first_name: "shoal-test", username: "shoal_test_bot" }

const answer = (method: string): unknown => {
  if (method === "getMe") {
    return BOT_USER
  }
  if (method === "getUpdates") {
    return []
  }
  return true
}

const handle = (fake: { methods: Array<string> }) => (req: IncomingMessage, res: ServerResponse) => {
  const method = (req.url ?? "").split("/").pop() ?? ""
  fake.methods.push(method)
  req.resume()
  req.on("end", () => {
    // Long-poll-like pacing so getUpdates does not spin.
    setTimeout(
      () => {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ ok: true, result: answer(method) }))
      },
      method === "getUpdates" ? 20 : 0,
    )
  })
}

const FakeTelegramServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<FakeServer>((resolve) => {
        const methods: Array<string> = []
        const server = createServer(handle({ methods }))
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo
          resolve({ url: `http://127.0.0.1:${port}`, methods, server })
        })
      }),
  ),
  (fake) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          fake.server.closeAllConnections()
          fake.server.close(() => resolve())
        }),
    ),
)

const waitFor = (predicate: () => boolean, steps = 100) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps && !predicate(); step++) {
      yield* Effect.sleep(Duration.millis(20))
    }
  })

describe("TelegramLive lifecycle", () => {
  it.live("runs setMyCommands and deleteWebhook before polling, and stops polling on release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeTelegramServer
        const layer = Layer.provideMerge(
          TelegramLive({
            token: Redacted.make(TOKEN),
            allowedUserIds: [ALLOWED_USER],
            forumChatId: FORUM_CHAT,
            apiRoot: fake.url,
          }),
          TestLayer,
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(layer)
            yield* waitFor(() => fake.methods.includes("getUpdates"))
          }),
        )
        // Order: boot calls first, then polling.
        expect(fake.methods.indexOf("setMyCommands")).toBeGreaterThanOrEqual(0)
        expect(fake.methods.indexOf("deleteWebhook")).toBeLessThan(fake.methods.indexOf("getUpdates"))
        expect(fake.methods.indexOf("setMyCommands")).toBeLessThan(fake.methods.indexOf("getUpdates"))
        // Released: once the scope has closed, no further request reaches the server.
        const settled = fake.methods.length
        yield* Effect.sleep(Duration.millis(300))
        expect(fake.methods.length).toBe(settled)
      }),
    ),
  )
})
