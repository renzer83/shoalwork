import { createHash, randomBytes } from "node:crypto"
import { BotId, SchemaViolation, TaskId } from "@shoalwork/contracts"
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// One token per Bot execution (02-architecture §12). The Bot's reef MCP server presents it as a bearer; the core
// answers only for the Bot and repo it was issued for. Only the SHA-256 of the token is stored.
export const MCP_TOKEN_PREFIX = "mcp_"
const TOKEN_PATTERN = /^mcp_[A-Za-z0-9_-]{43}$/
export const MAX_MCP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
// Expired or revoked rows are kept this long, then deleted on the next revoke.
export const MCP_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface McpScope {
  readonly botId: BotId
  readonly repo: string
  readonly taskId: TaskId
}

export interface IssueMcpToken {
  readonly botId: BotId
  readonly repo: string
  readonly taskId: TaskId
  // Lifetime in milliseconds, 1 .. MAX_MCP_TOKEN_TTL_MS.
  readonly ttl: number
}

export interface IssuedMcpToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: string
}

// Unknown, revoked and expired tokens are one refusal to the caller; the reason is for the log only.
export class McpTokenRejected extends Data.TaggedError("McpTokenRejected")<{
  readonly reason: "unknown" | "expired" | "revoked"
}> {}

const TokenRow = Schema.Struct({
  bot_id: BotId,
  repo: Schema.String,
  task_id: TaskId,
  expires_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
})

const RowsOf = Schema.Array(TokenRow)

export interface McpTokensShape {
  readonly issue: (input: IssueMcpToken) => Effect.Effect<IssuedMcpToken, SchemaViolation | SqlError>
  // Only a usable token answers its scope; every other case fails with McpTokenRejected.
  readonly verify: (token: string) => Effect.Effect<McpScope, McpTokenRejected | SqlError>
  // Ends every token of the task. Idempotent.
  readonly revoke: (taskId: TaskId) => Effect.Effect<void, SqlError>
  // Boot: ends every token whose task is not running (a leftover of a run the restart interrupted). Idempotent.
  readonly revokeStale: () => Effect.Effect<void, SqlError>
}

export class McpTokens extends Context.Service<McpTokens, McpTokensShape>()("@shoalwork/McpTokens") {}

export const hashMcpToken = (token: string): string => createHash("sha256").update(token).digest("hex")

export const makeMcpTokens = (sql: SqlClient, clock: () => Date = () => new Date()): McpTokensShape => ({
  issue: (input) =>
    Effect.gen(function* () {
      if (!Number.isInteger(input.ttl) || input.ttl < 1 || input.ttl > MAX_MCP_TOKEN_TTL_MS) {
        return yield* Effect.fail(
          new SchemaViolation({ where: "mcp.issue.ttl", issue: "ttl must be an integer of 1..86400000 ms" }),
        )
      }
      if (input.repo.trim() === "") {
        return yield* Effect.fail(
          new SchemaViolation({ where: "mcp.issue.repo", issue: "repo must not be empty" }),
        )
      }
      const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
      const issuedAt = clock()
      const expiresAt = new Date(issuedAt.getTime() + input.ttl).toISOString()
      yield* sql`INSERT INTO mcp_tokens (token_hash, bot_id, repo, task_id, issued_at, expires_at)
        VALUES (${hashMcpToken(token)}, ${input.botId}, ${input.repo}, ${input.taskId},
          ${issuedAt.toISOString()}, ${expiresAt})`
      return { token: Redacted.make(token), expiresAt }
    }),

  verify: (token) =>
    Effect.gen(function* () {
      if (!TOKEN_PATTERN.test(token)) {
        return yield* Effect.fail(new McpTokenRejected({ reason: "unknown" }))
      }
      const rows = yield* sql`SELECT bot_id, repo, task_id, expires_at, revoked_at
        FROM mcp_tokens WHERE token_hash = ${hashMcpToken(token)}`
      const [row] = yield* Schema.decodeUnknownEffect(RowsOf)(rows).pipe(Effect.orDie)
      if (row === undefined) {
        return yield* Effect.fail(new McpTokenRejected({ reason: "unknown" }))
      }
      if (row.revoked_at !== null) {
        return yield* Effect.fail(new McpTokenRejected({ reason: "revoked" }))
      }
      if (Date.parse(row.expires_at) <= clock().getTime()) {
        return yield* Effect.fail(new McpTokenRejected({ reason: "expired" }))
      }
      return { botId: row.bot_id, repo: row.repo, taskId: row.task_id }
    }),

  revoke: (taskId) =>
    Effect.gen(function* () {
      const now = clock()
      yield* sql`UPDATE mcp_tokens SET revoked_at = ${now.toISOString()} WHERE task_id = ${taskId} AND revoked_at IS NULL`
      const cutoff = new Date(now.getTime() - MCP_TOKEN_RETENTION_MS).toISOString()
      yield* sql`DELETE FROM mcp_tokens WHERE expires_at < ${cutoff} OR (revoked_at IS NOT NULL AND revoked_at < ${cutoff})`
    }),
  revokeStale: () =>
    Effect.gen(function* () {
      const now = clock()
      yield* sql`UPDATE mcp_tokens SET revoked_at = ${now.toISOString()} WHERE revoked_at IS NULL
        AND task_id NOT IN (SELECT id FROM tasks WHERE state = 'running')`
    }),
})

export const McpTokensLive: Layer.Layer<McpTokens, never, SqlClient> = Layer.effect(
  McpTokens,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return makeMcpTokens(sql)
  }),
)
