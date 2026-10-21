import { readFileSync } from "node:fs"
import { Clock, Effect } from "effect"
import {
  type NotionHttpError,
  NotionHttpError as NotionHttpErrorValue,
  type NotionRequest,
  type NotionTransport,
} from "../../src/notion/client.js"

// Fixtures are read from test/fixtures (no network). Shapes follow the documented Notion answers.
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/notion/${name}`, import.meta.url), "utf8"))

export type Reply = (request: NotionRequest, index: number) => Effect.Effect<unknown, NotionHttpError>

export interface Sent {
  readonly request: NotionRequest
  // Effect clock time (ms) at which the request reached the transport.
  readonly at: number
}

// A transport that answers with `reply` and records every request with the time it left. No network.
export const fakeTransport = (reply: Reply) => {
  const sent: Array<Sent> = []
  const transport: NotionTransport = {
    send: (request) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        sent.push({ request, at })
        return yield* reply(request, sent.length - 1)
      }),
  }
  return { transport, sent }
}

export const ok =
  (body: unknown): Reply =>
  () =>
    Effect.succeed(body)

export const fail =
  (status: number, retryAfterMs?: number): Reply =>
  () =>
    Effect.fail(new NotionHttpErrorValue({ status, retryAfterMs }))
