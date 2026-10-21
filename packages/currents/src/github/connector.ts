import { type ConnectorId, ConnectorId as ConnectorIdSchema, type Risk } from "@shoalwork/contracts"
import { Schema } from "effect"
import { type ConnectorTool, GITHUB_TOOLS } from "./tools.js"
import type { GithubEventType } from "./webhook.js"

// A Connector is what a Bot may use of an external service: its tools, the risk of each, and the events it hears.
export interface Connector {
  readonly id: ConnectorId
  readonly permissions: ReadonlyArray<{ readonly tool: string; readonly risk: Risk }>
  readonly tools: ReadonlyArray<ConnectorTool>
  readonly triggers: ReadonlyArray<GithubEventType>
}

export const githubConnector: Connector = {
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
