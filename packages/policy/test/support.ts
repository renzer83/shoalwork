import { readFileSync } from "node:fs"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, type ToolCall } from "@shoalwork/contracts"
import { Effect, Layer, Schema } from "effect"
import { makePolicyTest, Policy } from "../src/index.js"

export const DEFAULT_YAML = readFileSync(
  new URL("../../../config/policies/default.yaml", import.meta.url),
  "utf8",
)
export const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
export const OTHER_BOT = Schema.decodeUnknownSync(BotId)("bot_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")

export const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })

// Builds the Policy service with Beacon in memory, so tests can read what was recorded.
export const policyWith = (
  sources: Record<string, string>,
  policyOf: (id: BotId) => string | undefined = () => "default",
) => makePolicyTest({ sources, policyOf }).pipe(Layer.provideMerge(BeaconTest))

export const baseLayer = policyWith({ default: DEFAULT_YAML })

export const evaluate = (call: ToolCall) =>
  Effect.gen(function* () {
    const policy = yield* Policy
    return yield* policy.evaluate(BOT, call)
  })

// Allow for one exact command. An allow on "git push origin *" is rejected at load (the :main probe deletes).
export const DEV_ALLOW_PUSH_MAIN = `rules:\n  - { bot: "*", tool: "Bash(git push origin main)", effect: allow }\n`
