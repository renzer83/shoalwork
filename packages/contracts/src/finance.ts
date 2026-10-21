import { Data, type Effect, Schema } from "effect"

// Neutral finance shapes: what a Bot sees whatever the provider (Stripe, billing-gateway, control-panel). Amounts are
// integers in the minor units of `currency`, as Stripe sends them. Text from providers is third-party data (R14).

export const FinanceProvider = Schema.Literals(["stripe", "billing-gateway", "control-panel"])
export type FinanceProvider = typeof FinanceProvider.Type

const NonEmpty = Schema.String.check(Schema.isMinLength(1))

export const InvoiceStatus = Schema.Literals(["draft", "open", "paid", "uncollectible", "void"])
export type InvoiceStatus = typeof InvoiceStatus.Type

// Only the brand and the last four digits of a card leave a connector, never the full payment method.
export const PaymentCardMask = Schema.Struct({
  brand: NonEmpty,
  last4: Schema.String.check(Schema.isPattern(/^[0-9]{4}$/)),
})
export type PaymentCardMask = typeof PaymentCardMask.Type

export const Customer = Schema.Struct({
  id: NonEmpty,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  defaultPaymentCard: Schema.NullOr(PaymentCardMask),
})
export type Customer = typeof Customer.Type

export const Subscription = Schema.Struct({
  id: NonEmpty,
  customerId: NonEmpty,
  status: NonEmpty,
  cancelAtPeriodEnd: Schema.Boolean,
  currency: Schema.NullOr(Schema.String),
  priceIds: Schema.Array(Schema.String),
})
export type Subscription = typeof Subscription.Type

export const Invoice = Schema.Struct({
  id: NonEmpty,
  customerId: Schema.NullOr(NonEmpty),
  subscriptionId: Schema.NullOr(NonEmpty),
  number: Schema.NullOr(Schema.String),
  status: Schema.NullOr(InvoiceStatus),
  currency: NonEmpty,
  amountDue: Schema.Int,
  amountPaid: Schema.Int,
  createdAt: Schema.DateTimeUtcFromString,
  hostedInvoiceUrl: Schema.NullOr(Schema.String),
})
export type Invoice = typeof Invoice.Type

// Provisional: the control-panel contract has not been received (ADR-022). Only what a Bot needs to name a project.
export const ControlPanelProject = Schema.Struct({
  id: NonEmpty,
  name: NonEmpty,
})
export type ControlPanelProject = typeof ControlPanelProject.Type

// A failed read. `status` is the HTTP status (0 when no answer came); `reason` tells the caller why, never the body.
export class FinanceReadError extends Data.TaggedError("FinanceReadError")<{
  readonly provider: FinanceProvider
  readonly op: string
  readonly reason: "unavailable" | "unreachable" | "http" | "invalid_response"
  readonly status: number
}> {}

// Read-only interfaces. Each adapter in currents implements one; an absent config yields a reader that fails as
// "unavailable" (the boot does not depend on the contract).
export interface BillingGatewayReader {
  readonly listCustomers: (query: {
    readonly email?: string | undefined
  }) => Effect.Effect<ReadonlyArray<Customer>, FinanceReadError>
  readonly listInvoices: (query: {
    readonly customerId: string
  }) => Effect.Effect<ReadonlyArray<Invoice>, FinanceReadError>
}

export interface ControlPanelReader {
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ControlPanelProject>, FinanceReadError>
  readonly getProject: (id: string) => Effect.Effect<ControlPanelProject, FinanceReadError>
}
