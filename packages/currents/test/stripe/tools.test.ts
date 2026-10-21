import { it } from "@effect/vitest"
import { Customer, Invoice, Subscription } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  makeStripe,
  Stripe,
  StripeError,
  StripeHttpError,
  type StripeRequest,
} from "../../src/stripe/client.js"
import { type Page, STRIPE_TOOLS, type StripeToolName } from "../../src/stripe/tools.js"
import { fixture } from "../finance/support.js"

// A transport that answers with `answer` (or fails with `status`) and records every request. No network.
const fakeStripe = (answer: unknown, status?: number) => {
  const sent: Array<StripeRequest> = []
  const stripe = makeStripe({
    send: (request) =>
      Effect.suspend(() => {
        sent.push(request)
        return status === undefined ? Effect.succeed(answer) : Effect.fail(new StripeHttpError({ status }))
      }),
  })
  return { sent, shape: stripe }
}

const run = (name: StripeToolName, input: unknown, answer: unknown, status?: number) => {
  const { sent, shape } = fakeStripe(answer, status)
  const tool = STRIPE_TOOLS.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return { sent, effect: tool.run(input).pipe(Effect.provideService(Stripe, shape)) }
}

describe("stripe tools", () => {
  it.effect("customers.list sends the email filter and maps the page to neutral customers", () =>
    Effect.gen(function* () {
      const { sent, effect } = run(
        "stripe.customers.list",
        { email: "ana@example.com" },
        fixture("stripe/customers.json"),
      )
      const page = (yield* effect) as Page<Customer>
      expect(sent).toEqual([
        {
          op: "stripe.customers.list",
          path: "customers",
          query: { limit: "10", email: "ana@example.com" },
        },
      ])
      expect(page.hasMore).toBe(true)
      expect(page.data).toHaveLength(2)
      const [first, second] = page.data
      expect(Schema.encodeSync(Customer)(first as Customer)).toEqual({
        id: "cus_TEST0001",
        email: "ana@example.com",
        name: "Ana Teste",
        createdAt: "2026-01-01T00:00:00.000Z",
        defaultPaymentCard: { brand: "visa", last4: "4242" },
      })
      expect(second?.defaultPaymentCard).toBeNull()
      expect(second?.email).toBeNull()
    }),
  )

  it.effect("customers.list never exposes the payment method beyond brand and last4", () =>
    Effect.gen(function* () {
      const { effect } = run("stripe.customers.list", {}, fixture("stripe/customers.json"))
      const page = (yield* effect) as Page<Customer>
      const serialized = JSON.stringify(page)
      for (const secret of [
        "pm_TEST0001",
        "FP_TEST_0001",
        "billing_details",
        "exp_month",
        "Rua Fictícia",
        "PT",
      ]) {
        expect(serialized).not.toContain(secret)
      }
      expect(serialized).toContain("4242")
    }),
  )

  it.effect("subscriptions.list sends the customer and maps the price ids", () =>
    Effect.gen(function* () {
      const { sent, effect } = run(
        "stripe.subscriptions.list",
        { customer: "cus_TEST0001" },
        fixture("stripe/subscriptions.json"),
      )
      const page = (yield* effect) as Page<Subscription>
      expect(sent[0]).toEqual({
        op: "stripe.subscriptions.list",
        path: "subscriptions",
        query: { customer: "cus_TEST0001", limit: "10" },
      })
      expect(page.hasMore).toBe(false)
      expect(Schema.encodeSync(Subscription)(page.data[0] as Subscription)).toEqual({
        id: "sub_TEST0001",
        customerId: "cus_TEST0001",
        status: "active",
        cancelAtPeriodEnd: false,
        currency: "eur",
        priceIds: ["price_TEST0001"],
      })
    }),
  )

  it.effect("invoices.list sends the customer and the status", () =>
    Effect.gen(function* () {
      const { sent, effect } = run(
        "stripe.invoices.list",
        { customer: "cus_TEST0001", status: "paid" },
        { data: [fixture("stripe/invoice.json")], has_more: false },
      )
      const page = (yield* effect) as Page<Invoice>
      expect(sent[0]?.query).toEqual({ customer: "cus_TEST0001", status: "paid", limit: "10" })
      expect(Schema.encodeSync(Invoice)(page.data[0] as Invoice)).toEqual({
        id: "in_TEST0001",
        customerId: "cus_TEST0001",
        subscriptionId: "sub_TEST0001",
        number: "ABC-0001",
        status: "paid",
        currency: "eur",
        amountDue: 1900,
        amountPaid: 1900,
        createdAt: "2026-01-01T00:00:00.000Z",
        hostedInvoiceUrl: "https://invoice.example.test/in_TEST0001",
      })
    }),
  )

  it.effect("invoices.list rejects an unknown status before any request is sent", () =>
    Effect.gen(function* () {
      const { sent, effect } = run(
        "stripe.invoices.list",
        { customer: "cus_TEST0001", status: "refunded" },
        {},
      )
      const error = yield* Effect.flip(effect)
      expect(error).toBeInstanceOf(StripeError)
      expect(error.message).toBe("stripe.invoices.list input does not match its schema")
      expect(sent).toHaveLength(0)
    }),
  )

  it.effect("invoice.get reads one invoice by id", () =>
    Effect.gen(function* () {
      const { sent, effect } = run(
        "stripe.invoice.get",
        { id: "in_TEST0001" },
        fixture("stripe/invoice.json"),
      )
      const invoice = yield* effect
      expect(sent[0]).toEqual({ op: "stripe.invoice.get", path: "invoices/in_TEST0001", query: {} })
      expect(invoice).toMatchObject({ id: "in_TEST0001", status: "paid" })
    }),
  )

  it.effect("an id with a path separator is refused before any request", () =>
    Effect.gen(function* () {
      const { sent, effect } = run("stripe.invoice.get", { id: "in_1/../customers" }, {})
      const error = yield* Effect.flip(effect)
      expect(error.status).toBe(0)
      expect(sent).toHaveLength(0)
    }),
  )

  it.effect("an answer that does not match its schema is an error, not a partial page", () =>
    Effect.gen(function* () {
      const { effect } = run("stripe.customers.list", {}, { data: [{ id: 42, created: 1 }], has_more: false })
      const error = yield* Effect.flip(effect)
      expect(error.message).toBe("stripe.customers.list answer does not match its schema")
    }),
  )

  it.effect("a transport failure reaches the caller with its status", () =>
    Effect.gen(function* () {
      const { effect } = run("stripe.invoice.get", { id: "in_TEST0001" }, {}, 404)
      const error = yield* Effect.flip(effect)
      expect(error.status).toBe(404)
      expect(error.message).toBe("stripe.invoice.get failed with HTTP 404")
    }),
  )
})
