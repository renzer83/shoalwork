import { it } from "@effect/vitest"
import { Customer, Invoice } from "@shoalwork/contracts"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect } from "vitest"
import { BillingGatewayConfig, billingGatewayReader, select } from "../../src/billing-gateway/adapter.js"
import { billingGatewayConnector } from "../../src/billing-gateway/connector.js"
import { authorizationOf, fixture, jsonResponse, recordingFetch } from "./support.js"

// Built at runtime so that no literal key-shaped string sits in the source (gitleaks).
const TOKEN = ["gw", "FAKETOKEN0001"].join("_")
const config = () => Schema.decodeUnknownSync(BillingGatewayConfig)(fixture("billing-gateway/config.json"))

describe("billing-gateway config and paths", () => {
  it("decodes the mapping of the fixture and rejects a path outside the simple subset", () => {
    expect(config().mapping.customers.fields.id).toBe("$.customer_id")
    const bad = { ...(fixture("billing-gateway/config.json") as object), mapping: undefined }
    expect(() => Schema.decodeUnknownSync(BillingGatewayConfig)(bad)).toThrow()
    const wildcard = structuredClone(fixture("billing-gateway/config.json")) as {
      mapping: { customers: { items: string } }
    }
    wildcard.mapping.customers.items = "$..data"
    expect(() => Schema.decodeUnknownSync(BillingGatewayConfig)(wildcard)).toThrow()
  })

  it("select reads keys and indexes and gives undefined for anything missing", () => {
    const root = { a: { b: [{ c: "x" }] } }
    expect(select(root, "$.a.b[0].c")).toBe("x")
    expect(select(root, "$.a.b[3].c")).toBeUndefined()
    expect(select(root, "$.a.zzz")).toBeUndefined()
    expect(select(root, "$")).toBe(root)
  })
})

describe("billing-gateway reader", () => {
  it.effect(
    "listCustomers maps the fixture through the mapping and keeps only brand and last4 of the card",
    () =>
      Effect.gen(function* () {
        const { doFetch, calls } = recordingFetch(() =>
          jsonResponse(fixture("billing-gateway/customers.json")),
        )
        const reader = billingGatewayReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
        const customers = yield* reader.listCustomers({ email: "bruno@example.test" })
        const call = calls[0]
        expect(call?.url.pathname).toBe("/customers")
        expect(call?.url.searchParams.get("email")).toBe("bruno@example.test")
        expect(authorizationOf(call ?? { url: new URL("https://x.test"), init: {} })).toBe(`Bearer ${TOKEN}`)
        expect(customers).toHaveLength(2)
        expect(Schema.encodeSync(Customer)(customers[0] as Customer)).toEqual({
          id: "c-1",
          email: "bruno@example.test",
          name: "Bruno Teste",
          createdAt: "2026-01-01T00:00:00.000Z",
          defaultPaymentCard: { brand: "mastercard", last4: "1111" },
        })
        expect(customers[1]?.defaultPaymentCard).toBeNull()
        expect(JSON.stringify(customers)).not.toContain("5555555555554444")
        expect(JSON.stringify(customers)).not.toContain("cvc")
      }),
  )

  it.effect("listInvoices maps the fixture with the customer as query", () =>
    Effect.gen(function* () {
      const { doFetch, calls } = recordingFetch(() => jsonResponse(fixture("billing-gateway/invoices.json")))
      const reader = billingGatewayReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const invoices = yield* reader.listInvoices({ customerId: "c-1" })
      expect(calls[0]?.url.pathname).toBe("/invoices")
      expect(calls[0]?.url.searchParams.get("customer")).toBe("c-1")
      expect(Schema.encodeSync(Invoice)(invoices[0] as Invoice)).toEqual({
        id: "b-1",
        customerId: "c-1",
        subscriptionId: null,
        number: "B-1",
        status: "paid",
        currency: "eur",
        amountDue: 1500,
        amountPaid: 1500,
        createdAt: "2026-01-02T00:00:00.000Z",
        hostedInvoiceUrl: null,
      })
    }),
  )

  it.effect("an item missing a required mapped field fails the whole read as invalid_response", () =>
    Effect.gen(function* () {
      const { doFetch } = recordingFetch(() =>
        jsonResponse({ data: [{ customer_id: "c-9" }, { contact: {} }] }),
      )
      const reader = billingGatewayReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const error = yield* Effect.flip(reader.listCustomers({}))
      expect(error._tag).toBe("FinanceReadError")
      expect(error.provider).toBe("billing-gateway")
      expect(error.reason).toBe("invalid_response")
    }),
  )

  it.effect("an answer without the array at items is invalid_response", () =>
    Effect.gen(function* () {
      const { doFetch } = recordingFetch(() => jsonResponse({ unexpected: true }))
      const reader = billingGatewayReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const error = yield* Effect.flip(reader.listInvoices({ customerId: "c-1" }))
      expect(error.reason).toBe("invalid_response")
    }),
  )

  it.effect("an HTTP 500 is an http failure with its status and no body", () =>
    Effect.gen(function* () {
      const { doFetch } = recordingFetch(() => jsonResponse({ secret: "do-not-show" }, 500))
      const reader = billingGatewayReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const error = yield* Effect.flip(reader.listCustomers({}))
      expect(error.reason).toBe("http")
      expect(error.status).toBe(500)
      expect(JSON.stringify(error)).not.toContain("do-not-show")
    }),
  )

  it.effect("without config the reader exists and every call fails as unavailable, without a request", () =>
    Effect.gen(function* () {
      const reader = billingGatewayReader()
      const customers = yield* Effect.flip(reader.listCustomers({}))
      const invoices = yield* Effect.flip(reader.listInvoices({ customerId: "c-1" }))
      expect(customers.reason).toBe("unavailable")
      expect(invoices.reason).toBe("unavailable")
    }),
  )

  it("the connector boots without config: no tools, no triggers, no permissions", () => {
    expect(billingGatewayConnector.id).toBe("billing-gateway")
    expect(billingGatewayConnector.tools).toEqual([])
    expect(billingGatewayConnector.permissions).toEqual([])
    expect(billingGatewayConnector.triggers).toEqual([])
  })
})
