import { QuotaConfig } from "@shoalwork/executors"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { executorsFor } from "../src/executors-compose.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

// The ACP agents are not on the quota store yet: they keep the legacy counter. This test pins which numbers that
// counter gets (debt, T-075): the codex 5h window of config/quotas.yaml, not a limit of their own.
const acpCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("../src/acp-executors.js", () => ({
  acpExecutors: (options: Record<string, unknown>) => {
    acpCalls.push(options)
    return []
  },
}))

const CONFIG = { permissionBridge: false, codexModel: undefined } as const

describe("ACP executors inherit the codex 5h limit (debt until they join the store)", () => {
  it("are handed the codex 5h window and soft limit of config/quotas.yaml", () => {
    const quotaConfig = Schema.decodeUnknownSync(QuotaConfig)({
      executors: {
        codex: {
          windows: [
            { kind: "5h", soft_tokens: 1000 },
            { kind: "7d", soft_tokens: 10_000 },
          ],
        },
      },
    })
    executorsFor({ config: CONFIG, tiers: DEFAULT_TIERS, quotaConfig, quota: undefined, onPath: () => false })
    expect(acpCalls.at(-1)).toMatchObject({ quotaWindowSeconds: 18_000, quotaSoftLimitTokens: 1000 })
  })

  it("have no limit to count against when the file names no codex 5h window", () => {
    const quotaConfig = Schema.decodeUnknownSync(QuotaConfig)({
      executors: { codex: { windows: [{ kind: "7d", soft_tokens: 10_000 }] } },
    })
    executorsFor({ config: CONFIG, tiers: DEFAULT_TIERS, quotaConfig, quota: undefined, onPath: () => false })
    expect(acpCalls.at(-1)).toMatchObject({
      quotaWindowSeconds: 18_000,
      quotaSoftLimitTokens: Number.MAX_SAFE_INTEGER,
    })
  })
})
