import { type RunnerHandle, run } from "@grammyjs/runner"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { Duration, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { createTelegramBot, installInbound, reportFailure } from "./bot.js"
import { type TelegramError, telegramError } from "./errors.js"
import { makeTelegramOut, TelegramOut } from "./out.js"

export { TelegramError } from "./errors.js"
export { type SendFlags, TelegramOut, type TelegramOutShape } from "./out.js"
export type { TopicRef } from "./topics.js"

export interface TelegramConfig {
  readonly token: Redacted.Redacted<string>
  readonly allowedUserIds: ReadonlyArray<number>
  readonly forumChatId: string
  // Bot API root for a self-hosted server or a local fake in tests. Default: api.telegram.org.
  readonly apiRoot?: string
}

// Handlers for these commands arrive with the core composition (T-024, T-028).
const COMMANDS = [
  { command: "start", description: "Start a conversation" },
  { command: "status", description: "Show Bot status" },
  { command: "stop", description: "Stop the current task" },
  { command: "pause", description: "Pause a Bot" },
  { command: "resume", description: "Resume a Bot" },
  { command: "help", description: "Show available commands" },
]

// Updates already fetched are still being handled after stop(); wait for them, up to 10 s.
const DRAIN_STEPS = 200
const DRAIN_STEP = Duration.millis(50)

const stopAndDrain = (running: RunnerHandle): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => running.stop())
    let step = 0
    while (step < DRAIN_STEPS && running.size() > 0) {
      yield* Effect.sleep(DRAIN_STEP)
      step += 1
    }
    if (running.size() > 0) {
      yield* Effect.logWarning("telegram updates still in flight after 10 s; released anyway")
    }
  })

// The token is read once here and never stored in a shape, a log line or an event.
export const TelegramLive = (
  config: TelegramConfig,
): Layer.Layer<TelegramOut, TelegramError, Beacon | BotRegistry | SqlClient> =>
  Layer.effect(
    TelegramOut,
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const registry = yield* BotRegistry
      const sql = yield* SqlClient
      const context = yield* Effect.context<Beacon | BotRegistry | SqlClient>()
      const bot = createTelegramBot(Redacted.value(config.token), {
        ...(config.apiRoot === undefined ? {} : { apiRoot: config.apiRoot }),
      })
      installInbound(bot, {
        allowedUserIds: new Set(config.allowedUserIds),
        forumChatId: config.forumChatId,
        context,
      })
      yield* Effect.tryPromise({
        try: () => bot.api.setMyCommands(COMMANDS),
        catch: telegramError("setMyCommands"),
      })
      // A webhook left over from another deployment would make getUpdates fail with 409.
      yield* Effect.tryPromise({
        try: () => bot.api.deleteWebhook(),
        catch: telegramError("deleteWebhook"),
      })
      // Silent: the runner's own console.error would print raw errors (URL with the token). They reach
      // error.raised through the task below, redacted.
      const handle = yield* Effect.acquireRelease(
        Effect.sync(() => run(bot, { runner: { silent: true } })),
        stopAndDrain,
      )
      yield* Effect.forkScoped(
        Effect.tryPromise({
          try: () => handle.task() ?? Promise.resolve(),
          catch: (cause: unknown) => cause,
        }).pipe(Effect.catch(reportFailure("telegram.polling"))),
      )
      return makeTelegramOut({ api: bot.api, forumChatId: config.forumChatId, sql, beacon, registry })
    }),
  )
