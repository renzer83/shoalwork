import { it } from "@effect/vitest"
import { ExecutorId, type Usage } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { makeQuotaStore, QuotaConfig } from "@shoalwork/executors"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { executorsFor, legacyLimitOf } from "../src/executors-compose.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")
const CONFIG = { permissionBridge: false, codexModel: undefined } as const

// Synthetic limits (not the shipped config): claude-code 100 tokens per 5h, codex 1000 per 5h.
const quotaConfig = Schema.decodeUnknownSync(QuotaConfig)({
  executors: {
    "claude-code": { windows: [{ kind: "5h", soft_tokens: 100 }] },
    codex: {
      windows: [
        { kind: "5h", soft_tokens: 1000 },
        { kind: "7d", soft_tokens: 10_000 },
      ],
    },
  },
})

const usage = (tokens: number): Usage => ({
  tokensIn: tokens,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 0,
  seconds: 0,
})

const quotaOf = (executors: ReturnType<typeof executorsFor>, id: ExecutorId) => {
  const executor = executors.find((candidate) => candidate.id === id)
  return executor === undefined ? Effect.die(`no executor ${id}`) : executor.quota()
}

describe("legacyLimitOf", () => {
  it("takes the codex 5h window of the quota file for the legacy counters", () => {
    expect(legacyLimitOf(quotaConfig)).toEqual({ windowSeconds: 18_000, softLimitTokens: 1000 })
  })

  it("has no limit to count against when the file names no codex 5h window", () => {
    const bare = Schema.decodeUnknownSync(QuotaConfig)({ executors: {} })
    expect(legacyLimitOf(bare)).toEqual({ windowSeconds: 18_000, softLimitTokens: Number.MAX_SAFE_INTEGER })
  })
})

describe("executorsFor", () => {
  it.effect("gives the adapters the shared store, so their quota is the store's figure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const store = makeQuotaStore(sql, quotaConfig)
      yield* store.record(CLAUDE, usage(30))
      yield* store.record(CODEX, usage(250))
      const executors = executorsFor({
        config: CONFIG,
        tiers: DEFAULT_TIERS,
        quotaConfig,
        quota: store,
        onPath: (bin) => bin === "codex",
      })
      expect(executors.map((executor) => executor.id)).toContain(CODEX)
      expect(yield* quotaOf(executors, CLAUDE)).toMatchObject({ usedRatio: 0.3, available: true })
      expect(yield* quotaOf(executors, CODEX)).toMatchObject({ usedRatio: 0.25, available: true })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("registers codex only when its binary is on the path", () =>
    Effect.gen(function* () {
      const executors = executorsFor({
        config: CONFIG,
        tiers: DEFAULT_TIERS,
        quotaConfig,
        quota: undefined,
        onPath: () => false,
      })
      expect(executors.map((executor) => executor.id)).not.toContain(CODEX)
    }),
  )

  it.effect("reports unlimited without a store, whatever usage there is", () =>
    Effect.gen(function* () {
      const executors = executorsFor({
        config: CONFIG,
        tiers: DEFAULT_TIERS,
        quotaConfig,
        quota: undefined,
        onPath: (bin) => bin === "codex",
      })
      expect(yield* quotaOf(executors, CLAUDE)).toEqual({ executor: CLAUDE, usedRatio: 0, available: true })
    }),
  )
})
