import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import {
  makeStripe,
  STRIPE_API_ROOT,
  STRIPE_API_VERSION,
  StripeError,
  stripeTransport,
} from "../../src/stripe/client.js"
import { authorizationOf, jsonResponse, recordingFetch } from "../finance/support.js"

// Built at runtime so that no literal key-shaped string sits in the source (gitleaks).
const KEY = ["rk", "test", "FAKEKEY0001"].join("_")

const customers = {
  op: "stripe.customers.list",
  path: "customers",
  query: { limit: "10", email: "a@example.test" },
}

describe("stripe transport", () => {
  it.effect("sends a GET with the bearer key, the pinned Stripe-Version and the query", () =>
    Effect.gen(function* () {
      const { doFetch, calls } = recordingFetch(() =>
        jsonResponse({ object: "list", data: [], has_more: false }),
      )
      const transport = stripeTransport(Redacted.make(KEY), { fetch: doFetch })
      yield* transport.send(customers)
      expect(calls).toHaveLength(1)
      const [call] = calls
      expect(call?.url.toString().startsWith(`${STRIPE_API_ROOT}/customers?`)).toBe(true)
      expect(call?.url.searchParams.get("email")).toBe("a@example.test")
      expect(call?.init.method).toBe("GET")
      expect(authorizationOf(call ?? { url: new URL("https://x.test"), init: {} })).toBe(`Bearer ${KEY}`)
      expect(STRIPE_API_VERSION).toBe("2026-09-30.endive")
    }),
  )

  it.effect("maps an HTTP error to StripeError with the status, and never shows the key", () =>
    Effect.gen(function* () {
      const { doFetch } = recordingFetch(() => jsonResponse({ error: { message: "bad key" } }, 401))
      const stripe = makeStripe(stripeTransport(Redacted.make(KEY), { fetch: doFetch }))
      const error = yield* Effect.flip(stripe.request(customers))
      expect(error).toBeInstanceOf(StripeError)
      expect(error.status).toBe(401)
      expect(error.message).toBe("stripe.customers.list failed with HTTP 401")
      expect(error.message).not.toContain(KEY)
    }),
  )

  it.effect("a network failure is StripeError with status 0", () =>
    Effect.gen(function* () {
      const doFetch = (): Promise<Response> => Promise.reject(new Error(`connect to ${KEY} refused`))
      const stripe = makeStripe(stripeTransport(Redacted.make(KEY), { fetch: doFetch }))
      const error = yield* Effect.flip(stripe.request(customers))
      expect(error.status).toBe(0)
      expect(error.message).toBe("stripe.customers.list failed")
      expect(JSON.stringify(error)).not.toContain(KEY)
    }),
  )

  it.effect("a 429 is reported as rate limited, not retried", () =>
    Effect.gen(function* () {
      const { doFetch, calls } = recordingFetch(() => jsonResponse({}, 429))
      const stripe = makeStripe(stripeTransport(Redacted.make(KEY), { fetch: doFetch }))
      const error = yield* Effect.flip(stripe.request(customers))
      expect(error.message).toBe("stripe.customers.list rate limited")
      expect(calls).toHaveLength(1)
    }),
  )
})
