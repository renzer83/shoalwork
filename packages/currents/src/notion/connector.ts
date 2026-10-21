import { ConnectorId as ConnectorIdSchema } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { Connector } from "../connector.js"
import { NOTION_TOOLS, type NotionTool } from "./tools.js"

// Notion has no webhook this connector can rely on (UNVERIFIED in 06-research §5): new and edited pages come from a
// poll of the data source, which emits these two events.
export const NOTION_TRIGGERS = ["notion.page_created", "notion.page_updated"] as const
export type NotionTrigger = (typeof NOTION_TRIGGERS)[number]

export type NotionConnector = Connector<NotionTool, NotionTrigger>

export const notionConnector: NotionConnector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("notion"),
  permissions: NOTION_TOOLS.map((tool) => ({ tool: tool.name, risk: tool.risk })),
  tools: NOTION_TOOLS,
  triggers: NOTION_TRIGGERS,
}
