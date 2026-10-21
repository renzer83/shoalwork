import { ConnectorId as ConnectorIdSchema } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { Connector } from "../connector.js"

// Obsidian is an input only: the vault is read by the knowledge sync, and no Bot calls it. So no tools and no triggers.
export const obsidianConnector: Connector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("obsidian"),
  permissions: [],
  tools: [],
  triggers: [],
}
