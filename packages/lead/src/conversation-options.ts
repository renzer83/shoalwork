import type { WarmChatPoolOptions } from "@shoalwork/executors"
import type { BotFactoryConfig } from "./bot-factory.js"
import type { MemoryPort } from "./commands/memory.js"

export interface ConversationOptions {
  // Whether the Telegram connector runs (default true). Off: only the app channel answers, no topics are created
  // and no approval card is sent to Telegram.
  readonly telegram?: boolean
  // Long-lived chat processes per conversation. Absent: every turn runs the one-shot chat.
  readonly warm?: WarmChatPoolOptions
  // Shorter messages are never escalated to the decision tier (escalation.ts).
  readonly minEscalationChars?: number
  readonly chatTimeoutMs?: number
  // Creating Bots by conversation (bot-factory.ts). Absent: "create a bot" is an ordinary message.
  // The rest of the factory's dependencies (database, registry, Telegram, the model) come from the layer.
  readonly botFactory?: BotFactoryOptions
  // Rolling window of a Bot's budget (budget.ts): a task whose owner is already over it gets no provisional ack.
  readonly botBudgetWindowMs?: number
  // What /remember and /forget talk to. Absent: the Reef of the layer's context, when there is one.
  readonly memory?: MemoryPort
}

export interface BotFactoryOptions {
  readonly botsDir: string
  // Executors a created Bot may use (registry names).
  readonly executors: ReadonlyArray<string>
  readonly config: BotFactoryConfig
}
