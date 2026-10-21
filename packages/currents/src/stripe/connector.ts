import { ConnectorId as ConnectorIdSchema } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { Connector } from "../connector.js"
import { STRIPE_TOOLS, type StripeTool } from "./tools.js"

// Read-only in this phase (T-090): no triggers, so no event of Stripe reaches a Tide.
export type StripeConnector = Connector<StripeTool, never>

export const stripeConnector: StripeConnector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("stripe"),
  permissions: STRIPE_TOOLS.map((tool) => ({ tool: tool.name, risk: tool.risk })),
  tools: STRIPE_TOOLS,
  triggers: [],
}
