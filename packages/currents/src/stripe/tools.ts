import {
  Customer,
  Invoice,
  InvoiceStatus,
  type PaymentCardMask,
  type Risk,
  Subscription,
} from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import { Stripe, StripeError } from "./client.js"

export type StripeToolName =
  | "stripe.customers.list"
  | "stripe.subscriptions.list"
  | "stripe.invoices.list"
  | "stripe.invoice.get"

// The first page only: Stripe's default size. Lists say whether more pages exist; this connector does not walk them.
const PAGE_SIZE = 10

// Stripe ids go into a path and a query: only the characters Stripe ids have.
const StripeId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_]{1,255}$/))
const Email = Schema.String.check(Schema.isMaxLength(320)).check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/))

const CustomerListInput = Schema.Struct({ email: Schema.optionalKey(Email) })
const SubscriptionListInput = Schema.Struct({ customer: StripeId })
const InvoiceListInput = Schema.Struct({ customer: StripeId, status: InvoiceStatus })
const InvoiceGetInput = Schema.Struct({ id: StripeId })

// Wire shapes: only the fields these tools read. Other fields of an answer are ignored, not an error. Text in these
// answers (names, emails) is third-party data (R14).
const ListWire = Schema.Struct({ data: Schema.Array(Schema.Unknown), has_more: Schema.Boolean })

const PaymentMethodWire = Schema.Struct({
  card: Schema.optionalKey(Schema.Struct({ brand: Schema.String, last4: Schema.String })),
})

const CustomerWire = Schema.Struct({
  id: Schema.String,
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created: Schema.Int,
  invoice_settings: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ default_payment_method: Schema.optionalKey(Schema.Unknown) })),
  ),
})

const SubscriptionWire = Schema.Struct({
  id: Schema.String,
  customer: Schema.String,
  status: Schema.String,
  cancel_at_period_end: Schema.Boolean,
  currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
  items: Schema.optionalKey(
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ price: Schema.optionalKey(Schema.Struct({ id: Schema.String })) })),
    }),
  ),
})

const InvoiceWire = Schema.Struct({
  id: Schema.String,
  customer: Schema.NullOr(Schema.String),
  subscription: Schema.optionalKey(Schema.NullOr(Schema.String)),
  number: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.NullOr(Schema.String),
  currency: Schema.String,
  amount_due: Schema.Int,
  amount_paid: Schema.Int,
  created: Schema.Int,
  hosted_invoice_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export interface Page<A> {
  readonly data: ReadonlyArray<A>
  readonly hasMore: boolean
}

export type StripeToolResult = Page<Customer> | Page<Subscription> | Page<Invoice> | Invoice

export interface StripeTool {
  readonly name: StripeToolName
  readonly risk: Risk
  readonly run: (input: unknown) => Effect.Effect<StripeToolResult, StripeError, Stripe>
}

const invalid = (op: string): StripeError =>
  new StripeError({ op, message: `${op} answer does not match its schema`, status: 0 })

const decodeInput = <A, I>(
  op: string,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, StripeError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(
      () => new StripeError({ op, message: `${op} input does not match its schema`, status: 0 }),
    ),
  )

const decodeAnswer = <A, I>(
  op: string,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, StripeError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(() => invalid(op)))

// Unix seconds to an ISO instant. Null when the number is outside Date's range, so the neutral schema rejects it.
const isoOf = (seconds: number): string | null => {
  const at = new Date(seconds * 1000)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

// Keeps brand and last4 of a card. A payment method sent as a bare id (not expanded) has no card to show: null.
// Everything else of the payment method (ids, fingerprints, billing details, expiry) is dropped here.
const cardOf = (raw: unknown): PaymentCardMask | null => {
  const method = Schema.decodeUnknownOption(PaymentMethodWire)(raw)
  if (Option.isNone(method) || method.value.card === undefined) return null
  return { brand: method.value.card.brand, last4: method.value.card.last4 }
}

const pageOf = <A>(
  op: string,
  answer: unknown,
  item: (raw: unknown) => Effect.Effect<A, StripeError>,
): Effect.Effect<Page<A>, StripeError> =>
  Effect.gen(function* () {
    const list = yield* decodeAnswer(op, ListWire, answer)
    const data = yield* Effect.forEach(list.data, item)
    return { data, hasMore: list.has_more }
  })

const customerOf =
  (op: string) =>
  (raw: unknown): Effect.Effect<Customer, StripeError> =>
    Effect.gen(function* () {
      const wire = yield* decodeAnswer(op, CustomerWire, raw)
      return yield* decodeAnswer(op, Customer, {
        id: wire.id,
        email: wire.email ?? null,
        name: wire.name ?? null,
        createdAt: isoOf(wire.created),
        defaultPaymentCard: cardOf(wire.invoice_settings?.default_payment_method),
      })
    })

const subscriptionOf =
  (op: string) =>
  (raw: unknown): Effect.Effect<Subscription, StripeError> =>
    Effect.gen(function* () {
      const wire = yield* decodeAnswer(op, SubscriptionWire, raw)
      const priceIds = (wire.items?.data ?? []).flatMap((item) =>
        item.price === undefined ? [] : [item.price.id],
      )
      return yield* decodeAnswer(op, Subscription, {
        id: wire.id,
        customerId: wire.customer,
        status: wire.status,
        cancelAtPeriodEnd: wire.cancel_at_period_end,
        currency: wire.currency ?? null,
        priceIds,
      })
    })

const invoiceOf =
  (op: string) =>
  (raw: unknown): Effect.Effect<Invoice, StripeError> =>
    Effect.gen(function* () {
      const wire = yield* decodeAnswer(op, InvoiceWire, raw)
      return yield* decodeAnswer(op, Invoice, {
        id: wire.id,
        customerId: wire.customer,
        subscriptionId: wire.subscription ?? null,
        number: wire.number ?? null,
        status: wire.status,
        currency: wire.currency,
        amountDue: wire.amount_due,
        amountPaid: wire.amount_paid,
        createdAt: isoOf(wire.created),
        hostedInvoiceUrl: wire.hosted_invoice_url ?? null,
      })
    })

const customersList: StripeTool = {
  name: "stripe.customers.list",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const op = "stripe.customers.list"
      const args = yield* decodeInput(op, CustomerListInput, raw)
      const stripe = yield* Stripe
      const query: Record<string, string> = { limit: String(PAGE_SIZE) }
      if (args.email !== undefined) query.email = args.email
      const answer = yield* stripe.request({ op, path: "customers", query })
      return yield* pageOf(op, answer, customerOf(op))
    }),
}

const subscriptionsList: StripeTool = {
  name: "stripe.subscriptions.list",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const op = "stripe.subscriptions.list"
      const args = yield* decodeInput(op, SubscriptionListInput, raw)
      const stripe = yield* Stripe
      const answer = yield* stripe.request({
        op,
        path: "subscriptions",
        query: { customer: args.customer, limit: String(PAGE_SIZE) },
      })
      return yield* pageOf(op, answer, subscriptionOf(op))
    }),
}

const invoicesList: StripeTool = {
  name: "stripe.invoices.list",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const op = "stripe.invoices.list"
      const args = yield* decodeInput(op, InvoiceListInput, raw)
      const stripe = yield* Stripe
      const answer = yield* stripe.request({
        op,
        path: "invoices",
        query: { customer: args.customer, status: args.status, limit: String(PAGE_SIZE) },
      })
      return yield* pageOf(op, answer, invoiceOf(op))
    }),
}

const invoiceGet: StripeTool = {
  name: "stripe.invoice.get",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const op = "stripe.invoice.get"
      const args = yield* decodeInput(op, InvoiceGetInput, raw)
      const stripe = yield* Stripe
      const answer = yield* stripe.request({ op, path: `invoices/${args.id}`, query: {} })
      return yield* invoiceOf(op)(answer)
    }),
}

const TOOLS: Record<StripeToolName, StripeTool> = {
  "stripe.customers.list": customersList,
  "stripe.subscriptions.list": subscriptionsList,
  "stripe.invoices.list": invoicesList,
  "stripe.invoice.get": invoiceGet,
}

export const STRIPE_TOOLS: ReadonlyArray<StripeTool> = Object.values(TOOLS)
