import { it } from "@effect/vitest"
import { BotId, ExecutorId, type ToolCall } from "@shoalwork/contracts"
import { Policy } from "@shoalwork/policy"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ACP_AGENTS, acpExecutors, acpPolicy } from "../src/acp-executors.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000000")
const CALL: ToolCall = { tool: "Bash", input: { command: "ls" } }
const CONTEXT = { cwd: "/work", roots: ["/work"] }

// A Policy that answers everything with allow/read: enough to see the adapter hand the decision through.
const fakePolicy = {
  evaluate: () => Effect.succeed({ effect: "allow", risk: "read" } as const),
  riskOf: () => "read" as const,
  rulesOf: () => Effect.succeed([]),
  workspaceRoots: [] as ReadonlyArray<string>,
  reload: () => Effect.void,
}

describe("ACP_AGENTS", () => {
  it("names acp-opencode and acp-gemini, and both decode as ExecutorId", () => {
    expect(ACP_AGENTS.map((agent) => agent.id)).toEqual([
      Schema.decodeUnknownSync(ExecutorId)("acp-opencode"),
      Schema.decodeUnknownSync(ExecutorId)("acp-gemini"),
    ])
  })
})

describe("acpExecutors", () => {
  it("registers the two ACP executors when the binaries are on PATH, with the ACP mapTier", () => {
    const executors = acpExecutors({
      onPath: () => true,
      quotaWindowSeconds: 60,
      quotaSoftLimitTokens: 1000,
    })
    expect(executors.map((executor) => executor.id)).toEqual(ACP_AGENTS.map((agent) => agent.id))
    for (const executor of executors) {
      expect(executor.mapTier("heavy")).toEqual({ model: "default" })
    }
  })

  it("registers nothing when no binary is on PATH", () => {
    const executors = acpExecutors({
      onPath: () => false,
      quotaWindowSeconds: 60,
      quotaSoftLimitTokens: 1000,
    })
    expect(executors).toEqual([])
  })
})

describe("acpPolicy", () => {
  it.effect("asks fail-closed (external) without a Policy service", () =>
    Effect.gen(function* () {
      const decision = yield* acpPolicy(BOT, CALL, CONTEXT)
      expect(decision).toEqual({ effect: "ask", risk: "external" })
    }),
  )

  it.effect("returns the Policy decision when the service is present", () =>
    Effect.gen(function* () {
      const decision = yield* acpPolicy(BOT, CALL, CONTEXT).pipe(Effect.provideService(Policy, fakePolicy))
      expect(decision).toEqual({ effect: "allow", risk: "read" })
    }),
  )
})
