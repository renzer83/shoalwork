import { it } from "@effect/vitest"
import { VoiceError } from "@shoalwork/contracts"
import { Effect, Option, Stream } from "effect"
import { describe, expect } from "vitest"
import { serveTriggers, TRIGGER_BODY_LIMIT_BYTES } from "../../src/http.js"
import { makeTrigger, type TriggerMode } from "../../src/wake/triggers.js"

const TOKEN = "test-token-not-a-secret"

// The trigger with the given mode and the server in front of it, on a free loopback port.
const serve = (mode: TriggerMode) =>
  Effect.gen(function* () {
    const trigger = yield* makeTrigger(mode, Option.none())
    const server = yield* serveTriggers(trigger, { token: TOKEN, port: 0 })
    return { trigger, base: `http://127.0.0.1:${server.port}` }
  })

const post = (base: string, path: string, body: string | undefined, token: string | null) =>
  Effect.promise(() =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body }),
    }),
  )

describe("trigger HTTP routes", () => {
  it.live("answer 401 without the token, with a wrong token, and before routing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { base } = yield* serve("hotkey")

        const none = yield* post(base, "/voice/wake", undefined, null)
        const wrong = yield* post(base, "/voice/wake", undefined, "nope")
        const unknown = yield* post(base, "/voice/other", undefined, null)

        expect(none.status).toBe(401)
        expect(wrong.status).toBe(401)
        expect(unknown.status).toBe(401)
        expect(yield* Effect.promise(() => none.json())).toEqual({ error: "unauthorized" })
      }),
    ),
  )

  it.live("POST /voice/wake with the token queues a hotkey trigger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { trigger, base } = yield* serve("hotkey")

        const response = yield* post(base, "/voice/wake", undefined, TOKEN)
        const seen = yield* Stream.runCollect(trigger.events().pipe(Stream.take(1)))

        expect(response.status).toBe(202)
        expect(seen).toEqual(["hotkey"])
      }),
    ),
  )

  it.live("answers 409 for a route whose source the mode leaves out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { base } = yield* serve("ptt")

        const wake = yield* post(base, "/voice/wake", undefined, TOKEN)

        expect(wake.status).toBe(409)
      }),
    ),
  )

  it.live("POST /voice/ptt opens then closes the listening window with pressed true and false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { trigger, base } = yield* serve("ptt")

        const down = yield* post(base, "/voice/ptt", JSON.stringify({ pressed: true }), TOKEN)
        const up = yield* post(base, "/voice/ptt", JSON.stringify({ pressed: false }), TOKEN)
        const seen = yield* Stream.runCollect(trigger.events().pipe(Stream.take(2)))

        expect([down.status, up.status]).toEqual([202, 202])
        expect(seen).toEqual(["ptt_down", "ptt_up"])
      }),
    ),
  )

  it.live("rejects a PTT body that is not {pressed: boolean} with 400, and an oversized body with 413", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { base } = yield* serve("ptt")

        const notJson = yield* post(base, "/voice/ptt", "pressed=true", TOKEN)
        const wrongShape = yield* post(base, "/voice/ptt", JSON.stringify({ pressed: "yes" }), TOKEN)
        const tooLarge = yield* post(base, "/voice/ptt", "x".repeat(TRIGGER_BODY_LIMIT_BYTES + 1), TOKEN)

        expect([notJson.status, wrongShape.status, tooLarge.status]).toEqual([400, 400, 413])
      }),
    ),
  )

  it.live("refuses to start without a token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const trigger = yield* makeTrigger("hotkey", Option.none())

        const error = yield* Effect.flip(serveTriggers(trigger, { token: "", port: 0 }))

        expect(error).toBeInstanceOf(VoiceError)
        expect(error.reason).toBe("VOICE_TRIGGER_TOKEN is not set")
      }),
    ),
  )
})
