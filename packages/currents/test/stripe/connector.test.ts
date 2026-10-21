import { describe, expect, it } from "vitest"
import { stripeConnector } from "../../src/stripe/connector.js"

describe("stripe connector", () => {
  it("is read-only: four read tools, every one risk read, no triggers", () => {
    expect(stripeConnector.id).toBe("stripe")
    expect(stripeConnector.tools.map((tool) => tool.name)).toEqual([
      "stripe.customers.list",
      "stripe.subscriptions.list",
      "stripe.invoices.list",
      "stripe.invoice.get",
    ])
    expect(stripeConnector.permissions.every((permission) => permission.risk === "read")).toBe(true)
    expect(stripeConnector.permissions.map((permission) => permission.tool)).toEqual(
      stripeConnector.tools.map((tool) => tool.name),
    )
    expect(stripeConnector.triggers).toEqual([])
  })
})
