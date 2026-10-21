import { ExecutorId } from "@shoalwork/contracts"
import { type AcpPolicy, type Executor, makeAcp } from "@shoalwork/executors"
import { Policy } from "@shoalwork/policy"
import { Effect, Option, Schema } from "effect"

// The ACP agents the product knows (02-architecture §5; 06-research/code-agent-clis.md §4): the CLI speaks ACP
// over stdio and asks for every permission. The adapter (T-056) decides with the Policy of the Bot.
export const ACP_AGENTS: ReadonlyArray<{
  readonly id: ExecutorId
  readonly bin: string
  readonly args: ReadonlyArray<string>
}> = [
  { id: Schema.decodeUnknownSync(ExecutorId)("acp-opencode"), bin: "opencode", args: ["acp"] },
  { id: Schema.decodeUnknownSync(ExecutorId)("acp-gemini"), bin: "gemini", args: ["--acp"] },
]

// The Policy of the Bot, asked at the moment of the permission request. Without the service (never the case in the
// core) the call is asked: fail-closed, nothing is pre-approved.
export const acpPolicy: AcpPolicy = (botId, call, context) =>
  Effect.serviceOption(Policy).pipe(
    Effect.flatMap((policy) =>
      Option.isSome(policy)
        ? policy.value.evaluate(botId, call, context)
        : Effect.succeed({ effect: "ask", risk: "external" } as const),
    ),
  )

// The ACP executors of this host: only the agents whose binary is on PATH are registered (ADR-011: no API key).
export const acpExecutors = (options: {
  readonly onPath: (bin: string) => boolean
  readonly quotaWindowSeconds: number
  readonly quotaSoftLimitTokens: number
}): ReadonlyArray<Executor> =>
  ACP_AGENTS.filter((agent) => options.onPath(agent.bin)).map((agent) =>
    makeAcp({
      id: agent.id,
      bin: agent.bin,
      args: agent.args,
      policy: acpPolicy,
      quotaWindowSeconds: options.quotaWindowSeconds,
      quotaSoftLimitTokens: options.quotaSoftLimitTokens,
    }),
  )
