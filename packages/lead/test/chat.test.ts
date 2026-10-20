import { it } from "@effect/vitest"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type ExecutorTask, NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { ChatSessions, ChatSessionsLive, ExecutorRegistry, makeRegistry } from "@shoalwork/executors"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { ChatFailure, makeChat } from "../src/chat.js"
import { fakeExecutor, makeFakeTank, TEST_TIERS } from "./support.js"

const TestLayer = Layer.provideMerge(
  ChatSessionsLive,
  Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb())),
)

const botAllowing = (allowed: ReadonlyArray<string>): NewBot =>
  Schema.decodeUnknownSync(NewBot)({
    name: "factory-bot",
    role: "coordinator",
    kind: "auxiliary",
    instructions: "You are a test bot.",
    executors: { preferred: allowed[0], allowed },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 500000, seconds: 1800, usd: 5 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
  })

const answer = (result: string) => Stream.make({ kind: "done" as const, result, artifacts: [] })

// Runs `body` with a chat over one fake executor (claude-code, the heavy tier of TEST_TIERS) that records its tasks.
const withChat = (
  bot: NewBot,
  stream: () => Stream.Stream<never> | ReturnType<typeof answer>,
  body: (
    chat: ReturnType<typeof makeChat>,
    runs: ReadonlyArray<ExecutorTask>,
  ) => Effect.Effect<void, unknown, BotRegistry>,
  heavyTimeoutMs?: number,
) => {
  const runs: Array<ExecutorTask> = []
  const executor = fakeExecutor(() => stream(), runs)
  return Effect.gen(function* () {
    const registry = yield* BotRegistry
    yield* registry.upsert(bot, "test")
    const chat = makeChat({
      tank: makeFakeTank().shape,
      bots: registry,
      executors: yield* ExecutorRegistry,
      sessions: yield* ChatSessions,
      tiers: TEST_TIERS,
      ...(heavyTimeoutMs === undefined ? {} : { heavyTimeoutMs }),
    })
    yield* body(chat, runs)
  }).pipe(Effect.provide(Layer.provideMerge(makeRegistry([executor]), TestLayer)))
}

describe("Chat.heavy", () => {
  it.effect(
    "runs one stateless, read-only, tool-less turn on the heavy executor and returns its answer",
    () =>
      withChat(
        botAllowing(["claude-code"]),
        () => answer('{"name":"marketing-faturium"}'),
        (chat, runs) =>
          Effect.gen(function* () {
            const registry = yield* BotRegistry
            const bot = yield* registry.getByName("factory-bot")
            const reply = yield* chat.heavy(bot.id, "propose a bot")
            expect(reply).toBe('{"name":"marketing-faturium"}')
            expect(runs).toHaveLength(1)
            expect(runs[0]).toMatchObject({
              tier: "heavy",
              permissionMode: "readonly",
              allowedTools: [],
              maxTurns: 1,
              prompt: "propose a bot",
            })
          }),
      ),
  )

  it.effect("refuses an executor the Bot does not allow, and runs nothing", () =>
    withChat(
      botAllowing(["codex"]),
      () => answer("should not run"),
      (chat, runs) =>
        Effect.gen(function* () {
          const registry = yield* BotRegistry
          const bot = yield* registry.getByName("factory-bot")
          const error = yield* Effect.flip(chat.heavy(bot.id, "propose a bot"))
          expect(error).toBeInstanceOf(ChatFailure)
          expect(error.message).toContain("not allowed")
          expect(runs).toHaveLength(0)
        }),
    ),
  )

  it.live("gives up after its own timeout with reason timeout", () =>
    withChat(
      botAllowing(["claude-code"]),
      () => Stream.never,
      (chat) =>
        Effect.gen(function* () {
          const registry = yield* BotRegistry
          const bot = yield* registry.getByName("factory-bot")
          const error = yield* Effect.flip(chat.heavy(bot.id, "propose a bot"))
          expect(error.reason).toBe("timeout")
        }),
      20,
    ),
  )
})
