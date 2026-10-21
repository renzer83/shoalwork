import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ControlPanelProject,
  Customer,
  FinanceReadError,
  Invoice,
  PaymentCardMask,
  Subscription,
} from "../src/finance.js"

const customer = {
  id: "cus_1",
  email: "ana@example.com",
  name: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  defaultPaymentCard: { brand: "visa", last4: "4242" },
}

const invoice = {
  id: "in_1",
  customerId: "cus_1",
  subscriptionId: null,
  number: null,
  status: "open",
  currency: "eur",
  amountDue: 1900,
  amountPaid: 0,
  createdAt: "2026-01-03T00:00:00.000Z",
  hostedInvoiceUrl: null,
}

const subscription = {
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  cancelAtPeriodEnd: true,
  currency: null,
  priceIds: ["price_1", "price_2"],
}

describe("finance contracts", () => {
  it("Customer round-trips and rejects a card whose last4 is not four digits", () => {
    expect(Schema.encodeSync(Customer)(Schema.decodeUnknownSync(Customer)(customer))).toEqual(customer)
    expect(() =>
      Schema.decodeUnknownSync(Customer)({ ...customer, defaultPaymentCard: { brand: "visa", last4: "42" } }),
    ).toThrow()
  })

  it("PaymentCardMask accepts only brand and last4 digits", () => {
    expect(Schema.decodeUnknownSync(PaymentCardMask)({ brand: "amex", last4: "0005" })).toEqual({
      brand: "amex",
      last4: "0005",
    })
    expect(() => Schema.decodeUnknownSync(PaymentCardMask)({ brand: "amex", last4: "00A5" })).toThrow()
  })

  it("Invoice round-trips and rejects a status outside the closed list", () => {
    expect(Schema.encodeSync(Invoice)(Schema.decodeUnknownSync(Invoice)(invoice))).toEqual(invoice)
    expect(() => Schema.decodeUnknownSync(Invoice)({ ...invoice, status: "refunded" })).toThrow()
  })

  it("Invoice rejects a non-integer amount", () => {
    expect(() => Schema.decodeUnknownSync(Invoice)({ ...invoice, amountDue: 19.5 })).toThrow()
  })

  it("Subscription round-trips", () => {
    expect(Schema.encodeSync(Subscription)(Schema.decodeUnknownSync(Subscription)(subscription))).toEqual(
      subscription,
    )
  })

  it("ControlPanelProject round-trips and rejects an empty name", () => {
    const project = { id: "p-1", name: "Projeto" }
    expect(
      Schema.encodeSync(ControlPanelProject)(Schema.decodeUnknownSync(ControlPanelProject)(project)),
    ).toEqual(project)
    expect(() => Schema.decodeUnknownSync(ControlPanelProject)({ id: "p-1", name: "" })).toThrow()
  })

  it("FinanceReadError is a tagged error that names the provider and the reason, not a body", () => {
    const error = new FinanceReadError({
      provider: "stripe",
      op: "stripe.invoice.get",
      reason: "http",
      status: 401,
    })
    expect(error._tag).toBe("FinanceReadError")
    expect(error.reason).toBe("http")
    expect(error.status).toBe(401)
  })
})
