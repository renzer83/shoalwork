import { BeaconTest } from "@shoalwork/beacon"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { STANDARD_QUESTIONS } from "../src/contract.js"
import { makeReflexLive, Reflex } from "../src/reflex.js"
import { config, loadFixture } from "./support.js"

// Real service, real network: runs only with LIVE=1 and REFLEX_URL pointing at a running services/reflex.
// REFLEX_TOKEN, when set, is sent as X-Reflex-Token, as the core does.
const live = process.env.LIVE === "1"
const baseUrl = (process.env.REFLEX_URL ?? "http://127.0.0.1:8300").trim().replace(/\/+$/, "")
const token = process.env.REFLEX_TOKEN

const PyResponse = Schema.Struct({
  answers: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
})

const COMPARED = ["intent", "owner", "risk", "language"] as const

describe.skipIf(!live)("reflex parity: TypeScript rules x Python service", () => {
  it("answers the same value for intent, owner, risk and language on every fixture case", async () => {
    const fixture = loadFixture()
    const layer = Layer.provideMerge(makeReflexLive(config), BeaconTest)
    const mismatches: Array<string> = []

    for (const item of fixture.cases) {
      const tsAnswers = await Effect.runPromise(
        Effect.gen(function* () {
          const reflex = yield* Reflex
          return yield* reflex.ask(item.facts, STANDARD_QUESTIONS)
        }).pipe(Effect.provide(layer)),
      )
      const response = await fetch(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { "x-reflex-token": token }),
        },
        body: JSON.stringify({ facts: item.facts, questions: STANDARD_QUESTIONS }),
      })
      expect(response.status).toBe(200)
      const { answers: pyAnswers } = Schema.decodeUnknownSync(PyResponse)(await response.json())

      for (const id of COMPARED) {
        const ts = tsAnswers.find((answer) => answer.id === id)?.value
        const py = pyAnswers.find((answer) => answer.id === id)?.value
        if (ts !== py) {
          mismatches.push(`${item.name} [${id}]: ts=${JSON.stringify(ts)} py=${JSON.stringify(py)}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
