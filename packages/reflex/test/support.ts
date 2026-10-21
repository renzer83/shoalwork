import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { BotId, ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { loadReflexConfig, type ReflexConfig } from "../src/config.js"
import type { Facts } from "../src/contract.js"

// The wire shape of Facts, as services/reflex/tests/cases.json writes it.
export const WireFacts = Schema.Struct({
  text: Schema.String,
  channel: Schema.Literals(["telegram", "api", "cli", "tide"]),
  userId: Schema.String,
  botHint: Schema.optionalKey(BotId),
  bots: Schema.Array(
    Schema.Struct({
      id: BotId,
      name: Schema.String,
      role: Schema.String,
      routing: Schema.optionalKey(
        Schema.Struct({ preferred: Schema.Array(ExecutorId), allowed: Schema.Array(ExecutorId) }),
      ),
    }),
  ),
  executors: Schema.Array(Schema.Struct({ id: ExecutorId, available: Schema.Boolean })),
  hasRepo: Schema.Boolean,
  language: Schema.optionalKey(Schema.String),
})

const ScoredValue = Schema.Struct({
  value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]),
  confidence: Schema.Number,
})

const FixtureCase = Schema.Struct({
  name: Schema.String,
  facts: WireFacts,
  expected: Schema.Struct({
    intent: ScoredValue,
    complexity: ScoredValue,
    owner: ScoredValue,
    executor: ScoredValue,
    parallelizable: ScoredValue,
    risk: ScoredValue,
    needs_approval: ScoredValue,
    language: ScoredValue,
  }),
})

const Fixture = Schema.Struct({ config: Schema.Unknown, cases: Schema.Array(FixtureCase) })

export const CASES_PATH = fileURLToPath(new URL("../../../services/reflex/tests/cases.json", import.meta.url))

// The fixture shared with the Python tests: the config it was exported from, and 56 cases with their answers.
export const loadFixture = (): typeof Fixture.Type =>
  Schema.decodeUnknownSync(Fixture)(JSON.parse(readFileSync(CASES_PATH, "utf8")))

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
