import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type BotId,
  type ExecutorEvent,
  type ExecutorTask,
  type ModelTier,
  newTaskId,
  StepId,
} from "@shoalwork/contracts"
import {
  CHAT_ID,
  ChatSessions,
  type Executor,
  type ExecutorRegistry,
  resolveTier,
  runChatTurn,
  type TierConfig,
  type WarmChatPool,
} from "@shoalwork/executors"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Data, Duration, Effect, Option, Schema, Semaphore, Stream } from "effect"
import { clip } from "./verdict.js"

// A chat or decision call that gave no answer. `timeout` is the 10 s cap; `error` is anything else.
export class ChatFailure extends Data.TaggedError("ChatFailure")<{
  readonly reason: "timeout" | "error"
  readonly message: string
}> {}

// A turn that takes longer than this is not a chat any more (spec: "Demorei demais").
export const CHAT_TIMEOUT_MS = 10_000
const CHAT_BUDGET = { tokens: 20_000, seconds: 20, usd: 0.5 }
// The heavy call (a Bot proposal) is structured output, not a chat: more budget and its own timeout.
const HEAVY_BUDGET = { tokens: 100_000, seconds: 60, usd: 1 }
export const HEAVY_TIMEOUT_MS = 60_000
const ERROR_MAX = 200

export interface ChatDeps {
  readonly tank: TankShape
  readonly bots: BotRegistryShape
  readonly executors: typeof ExecutorRegistry.Service
  readonly sessions: typeof ChatSessions.Service
  readonly tiers: TierConfig
  // Long-lived chat processes (T-163). Without it every turn spawns the one-shot chat.
  readonly warm?: WarmChatPool
  readonly timeoutMs?: number
  readonly heavyTimeoutMs?: number
}

// The text a finished chat run produced: its `done` result, else the reason it failed.
const answerOf = (events: ReadonlyArray<ExecutorEvent>): Effect.Effect<string, ChatFailure> => {
  const done = events.findLast((event) => event.kind === "done")
  if (done !== undefined && done.result.trim() !== "") {
    return Effect.succeed(done.result)
  }
  const failed = events.findLast((event) => event.kind === "error")
  return Effect.fail(
    new ChatFailure({
      reason: "error",
      message: clip(failed === undefined ? "no answer" : `${failed.code}: ${failed.message}`, ERROR_MAX),
    }),
  )
}

const describe = (error: unknown): string => {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Error"
  return clip(tag, ERROR_MAX)
}

const asFailure = (error: unknown): ChatFailure =>
  error instanceof ChatFailure ? error : new ChatFailure({ reason: "error", message: describe(error) })

// Chat-tier access for the conversation: the Bot's long-lived turns and the stateless calls (decision tier,
// summaries). The chat and decision tiers have no tools, so the chat executor needs no entry in
// bot.executors.allowed. That exception is closed: any other executor a tier resolves to (a Bot override, an
// alternative) must be in `allowed`, or the call fails.
export const makeChat = (deps: ChatDeps) => {
  const timeoutMs = deps.timeoutMs ?? CHAT_TIMEOUT_MS
  const heavyTimeoutMs = deps.heavyTimeoutMs ?? HEAVY_TIMEOUT_MS
  const contexts = new Map<BotId, TankContext>()
  // One turn at a time per conversation scope. Held before the timeout starts, so waiting for the previous turn
  // does not count against the 10 s.
  const locks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (scope: string): Semaphore.Semaphore => {
    const known = locks.get(scope)
    if (known !== undefined) {
      return known
    }
    const created = Semaphore.makeUnsafe(1)
    locks.set(scope, created)
    return created
  }

  // One work directory per Bot for all its chat turns (deterministic step id, so it survives restarts).
  const contextOf = (botId: BotId) =>
    Effect.gen(function* () {
      const known = contexts.get(botId)
      if (known !== undefined) {
        return known
      }
      const bot = yield* deps.bots.get(botId)
      const stepId = Schema.decodeUnknownSync(StepId)(`step_${botId.slice("bot_".length)}`)
      const ctx = yield* deps.tank.prepare(bot, { stepId })
      contexts.set(botId, ctx)
      return ctx
    })

  const pick = (botId: BotId, tier: ModelTier) =>
    Effect.gen(function* () {
      const bot = yield* deps.bots.get(botId)
      const all: ReadonlyArray<Executor> = yield* Effect.forEach(deps.executors.list(), (id) =>
        deps.executors.get(id),
      )
      const resolved = yield* resolveTier(deps.tiers, bot.modelTiers, tier, all)
      if (resolved.executor !== CHAT_ID && !bot.executors.allowed.includes(resolved.executor)) {
        return yield* Effect.fail(
          new ChatFailure({
            reason: "error",
            message: `executor ${resolved.executor} is not allowed for this Bot`,
          }),
        )
      }
      const executor = all.find((candidate) => candidate.id === resolved.executor)
      if (executor === undefined) {
        return yield* Effect.fail(new ChatFailure({ reason: "error", message: "executor missing" }))
      }
      return { executor, model: resolved.model, effort: resolved.effort }
    })

  const taskFor = (
    botId: BotId,
    tier: ModelTier,
    prompt: string,
    systemAppend: string | undefined,
    chosen: { readonly model: string; readonly effort: ExecutorTask["effort"] },
    budget: ExecutorTask["budget"] = CHAT_BUDGET,
  ): ExecutorTask => ({
    taskId: newTaskId(),
    botId,
    prompt,
    tier,
    model: chosen.model,
    ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
    ...(systemAppend === undefined ? {} : { systemAppend }),
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 1,
    budget,
  })

  const capped = <A>(
    run: Effect.Effect<A, ChatFailure>,
    limitMs: number = timeoutMs,
  ): Effect.Effect<A, ChatFailure> =>
    run.pipe(
      Effect.timeoutOption(Duration.millis(limitMs)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ChatFailure({ reason: "timeout", message: `over ${limitMs} ms` })),
          onSome: Effect.succeed,
        }),
      ),
    )

  // One turn of a conversation scope: resumes the scope's session and uses the warm process when there is one.
  const turn = (
    botId: BotId,
    scope: string,
    prompt: string,
    systemAppend: string,
  ): Effect.Effect<string, ChatFailure> =>
    lockFor(scope).withPermits(1)(
      capped(
        Effect.gen(function* () {
          const chosen = yield* pick(botId, "chat")
          const ctx = yield* contextOf(botId)
          const task = taskFor(botId, "chat", prompt, systemAppend, chosen)
          const events = yield* Stream.runCollect(
            runChatTurn(
              chosen.executor,
              scope,
              task,
              ctx,
              deps.warm === undefined ? {} : { warm: deps.warm },
            ),
          ).pipe(
            Effect.scoped,
            Effect.provideService(Tank, deps.tank),
            Effect.provideService(ChatSessions, deps.sessions),
          )
          return yield* answerOf(Array.from(events))
        }).pipe(Effect.catch((error) => Effect.fail(asFailure(error)))),
      ),
    )

  // A stateless call (no session, no warm process): the decision tier's closed questions and long summaries.
  const once = (
    botId: BotId,
    tier: "chat" | "decision",
    prompt: string,
    systemAppend?: string,
  ): Effect.Effect<string, ChatFailure> =>
    capped(
      Effect.gen(function* () {
        const chosen = yield* pick(botId, tier)
        const ctx = yield* contextOf(botId)
        const task = taskFor(botId, tier, prompt, systemAppend, chosen)
        const events = yield* Stream.runCollect(chosen.executor.run(task, ctx)).pipe(
          Effect.scoped,
          Effect.provideService(Tank, deps.tank),
        )
        return yield* answerOf(Array.from(events))
      }).pipe(Effect.catch((error) => Effect.fail(asFailure(error)))),
    )

  // One stateless call on the heavy tier for a structured answer (a Bot proposal). Read-only, no tools, one turn,
  // no session. Same executor rule as the chat: the resolved executor must be in bot.executors.allowed.
  const heavy = (botId: BotId, prompt: string): Effect.Effect<string, ChatFailure> =>
    capped(
      Effect.gen(function* () {
        const chosen = yield* pick(botId, "heavy")
        const ctx = yield* contextOf(botId)
        const task = taskFor(botId, "heavy", prompt, undefined, chosen, HEAVY_BUDGET)
        const events = yield* Stream.runCollect(chosen.executor.run(task, ctx)).pipe(
          Effect.scoped,
          Effect.provideService(Tank, deps.tank),
        )
        return yield* answerOf(Array.from(events))
      }).pipe(Effect.catch((error) => Effect.fail(asFailure(error)))),
      heavyTimeoutMs,
    )

  return { turn, once, heavy }
}

export type Chat = ReturnType<typeof makeChat>
