import { ConnectorId as ConnectorIdSchema } from "@shoalwork/contracts"
import { Schema } from "effect"
import type { Connector } from "../connector.js"
import { type ConnectorTool, GITHUB_TOOLS } from "./tools.js"
import type { GithubEventType } from "./webhook.js"

export type GithubConnector = Connector<ConnectorTool, GithubEventType>

export const githubConnector: GithubConnector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("github"),
  permissions: GITHUB_TOOLS.map((tool) => ({ tool: tool.name, risk: tool.risk })),
  tools: GITHUB_TOOLS,
  triggers: [
    "github.issues",
    "github.pull_request",
    "github.workflow_run",
    "github.check_suite",
    "github.push",
  ],
}
