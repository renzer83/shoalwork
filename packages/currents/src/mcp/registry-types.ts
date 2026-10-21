import type { FetchLike, Transport } from "@modelcontextprotocol/client"
import type {
  BotId,
  NotFound,
  PolicyDecision,
  PolicyDenied,
  SchemaViolation,
  ToolCall,
} from "@shoalwork/contracts"
import type { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { McpSecrets } from "./client.js"
import type { McpOAuthStore } from "./oauth.js"
import type { McpError, McpServer, McpServerForBot, McpToolInfo, NewMcpServer } from "./types.js"

// The policy's verdict on a call. Structural: the Policy service fits as it is (same shape as the Notion connector).
export interface McpToolGate {
  readonly evaluate: (botId: BotId, call: ToolCall) => Effect.Effect<PolicyDecision>
}

export interface McpAuthNeeded {
  readonly server: string
  readonly authorizationUrl: string
}

export type McpRegistryOptions = {
  readonly secretsOf: (botId: BotId | undefined) => McpSecrets
  readonly gate: McpToolGate
  readonly oauth?: {
    readonly store: McpOAuthStore
    // The core's GET /oauth/mcp/callback, as the authorization server must reach it.
    readonly redirectUrl: string
    readonly clientMetadataUrl?: string
    // Sends the authorization link to the user (an approval of type oauth, Telegram, the app). Never holds a token.
    readonly notify: (needed: McpAuthNeeded) => Effect.Effect<void>
  }
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  // Clock in ms, for the TTL of the OAuth state. Tests move it.
  readonly now?: () => number
  readonly transportFor?: (server: McpServer) => Transport
}

export interface McpRegistryShape {
  readonly upsert: (s: NewMcpServer) => Effect.Effect<McpServer, SchemaViolation | SqlError>
  readonly list: () => Effect.Effect<ReadonlyArray<McpServer>, SqlError>
  // Connects and lists tools. `botId` resolves the Vault keys of the server, when it has any.
  readonly test: (
    id: string,
    botId?: BotId,
  ) => Effect.Effect<{ readonly tools: ReadonlyArray<McpToolInfo> }, McpError | NotFound | SqlError>
  readonly allow: (
    botId: BotId,
    serverId: string,
    tools: ReadonlyArray<string> | "*",
  ) => Effect.Effect<void, NotFound | SchemaViolation | SqlError>
  // The enabled servers a Bot may use, with the tools it may call.
  readonly forBot: (botId: BotId) => Effect.Effect<ReadonlyArray<McpServerForBot>, SqlError>
  // `serverId` is the id or the name. `policyChecked`: the caller already got the Policy's allow (the openai-compat
  // executor judges before it asks); the Bot's tool list is still enforced.
  readonly call: (
    botId: BotId,
    serverId: string,
    tool: string,
    args: unknown,
    options?: { readonly policyChecked?: boolean },
  ) => Effect.Effect<unknown, PolicyDenied | McpError>
  // GET /oauth/mcp/callback: swaps the code for tokens (state is single use) and returns the server name.
  readonly completeOAuth: (
    state: string,
    code: string,
    iss?: string,
  ) => Effect.Effect<{ readonly server: string }, McpError>
}
