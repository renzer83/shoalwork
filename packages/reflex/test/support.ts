import { fileURLToPath } from "node:url"
import { BotId, ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { loadReflexConfig, type ReflexConfig } from "../src/config.js"
import type { Facts } from "../src/contract.js"

export const CONFIG_PATH = fileURLToPath(new URL("../../../config/reflex.config.yaml", import.meta.url))

export const config: ReflexConfig = Effect.runSync(loadReflexConfig(CONFIG_PATH))

export const LEAD = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")
export const DEV = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000002")
export const WRITER = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000003")
export const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
export const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")

export const BOTS: Facts["bots"] = [
  { id: LEAD, name: "lead", role: "coordinator" },
  {
    id: DEV,
    name: "dev-demo",
    role: "developer",
    routing: { preferred: [CLAUDE], allowed: [CLAUDE, CODEX] },
  },
  { id: WRITER, name: "writer", role: "content" },
]

export const EXECUTORS: Facts["executors"] = [
  { id: CLAUDE, available: true },
  { id: CODEX, available: true },
]

export const factsFor = (text: string, extra: Partial<Facts> = {}): Facts => ({
  text,
  channel: "telegram",
  userId: "42",
  bots: BOTS,
  executors: EXECUTORS,
  hasRepo: false,
  ...extra,
})
