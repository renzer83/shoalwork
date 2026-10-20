import { randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import { BotId, SchemaViolation, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  hashMcpToken,
  MAX_MCP_TOKEN_TTL_MS,
  MCP_TOKEN_RETENTION_MS,
  McpTokenRejected,
  makeMcpTokens,
} from "../src/mcp-tokens.js"

const botA = Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`)
const botB = Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`)
const taskOne = Schema.decodeUnknownSync(TaskId)(`task_${randomUUID()}`)
const taskTwo = Schema.decodeUnknownSync(TaskId)(`task_${randomUUID()}`)
const REPO = "shoalwork"
const newTaskId = (): TaskId => Schema.decodeUnknownSync(TaskId)(`task_${randomUUID()}`)
const HOUR = 60 * 60 * 1000

// A clock the test moves by hand, so expiry is checked without sleeping.
const manualClock = (start: number) => {
  let now = start
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) }
}

describe("McpTokens", () => {
  it.effect("issues a prefixed opaque token that verifies to its Bot, repo and task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = makeMcpTokens(sql)
      const issued = yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl: HOUR })
      const raw = Redacted.value(issued.token)
      expect(raw).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/)
      expect(issued.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const scope = yield* tokens.verify(raw)
      expect(scope).toEqual({ botId: botA, repo: REPO, taskId: taskOne })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("stores only the SHA-256 of the token, never the token", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = makeMcpTokens(sql)
      const issued = yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl: HOUR })
      const raw = Redacted.value(issued.token)
      const rows = yield* sql<{ readonly token_hash: string }>`SELECT token_hash FROM mcp_tokens`
      expect(rows.map((row) => row.token_hash)).toEqual([hashMcpToken(raw)])
      const dump = JSON.stringify(yield* sql`SELECT * FROM mcp_tokens`)
      expect(dump).not.toContain(raw)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("rejects a token it never issued, and a malformed one, as unknown", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = makeMcpTokens(sql)
      const forged = `mcp_${"a".repeat(43)}`
      const unknown = yield* Effect.flip(tokens.verify(forged))
      expect(unknown).toBeInstanceOf(McpTokenRejected)
      expect(unknown.reason).toBe("unknown")
      const malformed = yield* Effect.flip(tokens.verify("not-a-token"))
      expect(malformed.reason).toBe("unknown")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("rejects an expired token and accepts it until the moment of expiry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const time = manualClock(Date.parse("2026-10-20T12:00:00.000Z"))
      const tokens = makeMcpTokens(sql, time.clock)
      const issued = yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl: 60_000 })
      const raw = Redacted.value(issued.token)
      time.advance(59_999)
      expect(yield* tokens.verify(raw)).toMatchObject({ taskId: taskOne })
      time.advance(1)
      const expired = yield* Effect.flip(tokens.verify(raw))
      expect(expired.reason).toBe("expired")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("revoke ends the tokens of that task only, and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = makeMcpTokens(sql)
      const first = yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl: HOUR })
      const second = yield* tokens.issue({ botId: botB, repo: "other", taskId: taskTwo, ttl: HOUR })
      yield* tokens.revoke(taskOne)
      yield* tokens.revoke(taskOne)
      const revoked = yield* Effect.flip(tokens.verify(Redacted.value(first.token)))
      expect(revoked.reason).toBe("revoked")
      expect(yield* tokens.verify(Redacted.value(second.token))).toEqual({
        botId: botB,
        repo: "other",
        taskId: taskTwo,
      })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("refuses a ttl outside 1 ms .. 24 h and an empty repo", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = makeMcpTokens(sql)
      for (const ttl of [0, -1, 1.5, MAX_MCP_TOKEN_TTL_MS + 1, Number.NaN]) {
        const error = yield* Effect.flip(tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl }))
        expect(error).toBeInstanceOf(SchemaViolation)
      }
      const blank = yield* Effect.flip(tokens.issue({ botId: botA, repo: "  ", taskId: taskOne, ttl: HOUR }))
      expect(blank).toBeInstanceOf(SchemaViolation)
      const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM mcp_tokens`
      expect(rows[0]?.n).toBe(0)
    }).pipe(Effect.provide(withTempDb())),
  )
  it.effect("revoke deletes rows expired or revoked more than seven days ago, and keeps the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const time = manualClock(Date.parse("2026-10-20T12:00:00.000Z"))
      const tokens = makeMcpTokens(sql, time.clock)
      yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskOne, ttl: HOUR })
      const revokedEarly = yield* tokens.issue({ botId: botA, repo: REPO, taskId: taskTwo, ttl: HOUR })
      yield* tokens.revoke(taskTwo)
      time.advance(MCP_TOKEN_RETENTION_MS + HOUR + 1)
      const fresh = yield* tokens.issue({ botId: botB, repo: "other", taskId: taskOne, ttl: HOUR })
      yield* tokens.revoke(newTaskId())
      const rows = yield* sql<{ readonly token_hash: string }>`SELECT token_hash FROM mcp_tokens`
      expect(rows.map((row) => row.token_hash)).toEqual([hashMcpToken(Redacted.value(fresh.token))])
      expect(revokedEarly.expiresAt).not.toBe(fresh.expiresAt)
    }).pipe(Effect.provide(withTempDb())),
  )
})
