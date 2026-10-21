import { ConnectorId as ConnectorIdSchema } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { Connector } from "../connector.js"

// No tools and no triggers until the billing-gateway contract arrives (ADR-022). The connector exists and boots
// without config; the reader in ./adapter.ts is what fails as "unavailable".
export const billingGatewayConnector: Connector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("billing-gateway"),
  permissions: [],
  tools: [],
  triggers: [],
}
