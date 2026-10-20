import type { BotRegistryShape } from "@shoalwork/bots"
import type { BotId, BotState } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { TaskStoreShape } from "./tasks.js"

// The persistent pause: a flag per scope ("global" or "bot:<id>") in control_flags, and the Bot state that mirrors it.
// Only a pause leaves a flag; a stop does not.
export type PauseScope = { readonly _tag: "Global" } | { readonly _tag: "Bot"; readonly botId: BotId }

export const GLOBAL_SCOPE = "global"
export const botScope = (botId: BotId) => `bot:${botId}`
export const scopeOf = (target: PauseScope): string =>
  target._tag === "Global" ? GLOBAL_SCOPE : botScope(target.botId)

const FlagRow = Schema.Struct({ scope: Schema.String })

// Only these states change to paused (and back): blocked and waiting_approval are facts the pause must not erase.
const PAUSABLE: ReadonlySet<BotState> = new Set<BotState>(["idle", "working", "thinking", "done"])

export interface FlagDeps {
  readonly sql: SqlClient
  readonly bots: BotRegistryShape
  readonly tasks: TaskStoreShape
}

export const makeControlFlags = ({ sql, bots, tasks }: FlagDeps) => {
  const setFlag = (scope: string, paused: boolean) =>
    sql`INSERT INTO control_flags (scope, paused, updated_at) VALUES (${scope}, ${paused ? 1 : 0}, ${nowIso()})
      ON CONFLICT(scope) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`

  const pausedScopes = Effect.gen(function* () {
    const rows = yield* sql`SELECT scope FROM control_flags WHERE paused = 1`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(FlagRow))(rows).pipe(Effect.orDie)
    return new Set(decoded.map((row) => row.scope))
  })

  const markPaused = (botId: BotId) =>
    Effect.gen(function* () {
      const bot = (yield* bots.list()).find((entry) => entry.id === botId)
      if (bot !== undefined && PAUSABLE.has(bot.state)) {
        yield* bots.setState(botId, "paused")
      }
    })

  // A Bot that is not running anything is idle; one that is, is working.
  const settleBotState = (botId: BotId) =>
    Effect.gen(function* () {
      const count = yield* tasks.countRunning(botId)
      yield* bots.setState(botId, count > 0 ? "working" : "idle")
    })

  const unmarkPaused = (botId: BotId) =>
    Effect.gen(function* () {
      const bot = (yield* bots.list()).find((entry) => entry.id === botId)
      if (bot?.state === "paused") {
        yield* settleBotState(botId)
      }
    })

  const applyPause = (target: PauseScope) =>
    Effect.gen(function* () {
      if (target._tag === "Bot") {
        yield* bots.get(target.botId)
      }
      yield* setFlag(scopeOf(target), true)
      const affected = target._tag === "Global" ? (yield* bots.list()).map((bot) => bot.id) : [target.botId]
      yield* Effect.forEach(affected, markPaused, { discard: true })
    })

  const applyResume = (target: PauseScope) =>
    Effect.gen(function* () {
      if (target._tag === "Bot") {
        yield* bots.get(target.botId)
      }
      yield* setFlag(scopeOf(target), false)
      const flags = yield* pausedScopes
      const candidates = target._tag === "Global" ? (yield* bots.list()).map((bot) => bot.id) : [target.botId]
      // A Bot comes back only when neither its own pause nor the global one holds it.
      yield* Effect.forEach(
        candidates.filter((id) => !flags.has(botScope(id)) && !flags.has(GLOBAL_SCOPE)),
        unmarkPaused,
        { discard: true },
      )
    })

  return { setFlag, pausedScopes, markPaused, unmarkPaused, settleBotState, applyPause, applyResume }
}

export type ControlFlags = ReturnType<typeof makeControlFlags>
