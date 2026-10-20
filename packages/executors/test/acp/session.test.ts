import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { startFakeAgent, text, update } from "./fake-agent.js"
import {
  collect,
  executorWith,
  fakePolicy,
  kinds,
  runAgent,
  sessionIdOf,
  tankServing,
  task,
} from "./harness.js"

const { policy } = fakePolicy({})

const cost = (amount: number) => ({
  sessionUpdate: "usage_update" as const,
  used: 1,
  size: 10,
  cost: { amount, currency: "USD" },
})

describe("acp session updates", () => {
  it.effect("drops updates of another session and updates sent before the session is live", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        {
          chatterOnNew: true,
          onPrompt: async (call) => {
            await call.client.notify("session/update", {
              sessionId: "someone-else",
              update: text("FOREIGN"),
            })
            await update(call, text("mine"))
            return { stopReason: "end_turn" }
          },
        },
        policy,
      )
      expect(events.filter((e) => e.kind === "text")).toEqual([{ kind: "text", text: "mine" }])
    }),
  )

  it.effect("after a resume the first cost seen is a baseline, not new spend", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        {
          replay: ["OLD"],
          onPrompt: async (call) => {
            await update(call, cost(5))
            await update(call, cost(5.5))
            return { stopReason: "end_turn" }
          },
        },
        policy,
        task({ resumeSessionId: sessionIdOf("sess-9") }),
      )
      expect(events.flatMap((e) => (e.kind === "usage" ? [e.usage.usd] : []))).toEqual([0.5])
    }),
  )

  it.effect("a fresh session counts its first cost in full", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        {
          onPrompt: async (call) => {
            await update(call, cost(2))
            return { stopReason: "end_turn" }
          },
        },
        policy,
        task({ budget: { tokens: 1000, seconds: 600, usd: 10 } }),
      )
      expect(events.flatMap((e) => (e.kind === "usage" ? [e.usage.usd] : []))).toEqual([2])
    }),
  )

  it.effect("usage.seconds comes from the Effect clock", () =>
    Effect.gen(function* () {
      const promptSeen = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const agent = yield* startFakeAgent({
        onPrompt: async () => {
          Deferred.doneUnsafe(promptSeen, Effect.void)
          await Effect.runPromise(Deferred.await(release))
          return { stopReason: "end_turn", usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 } }
        },
      })
      const { shape } = tankServing(agent)
      const fiber = yield* Effect.forkChild(collect(executorWith(policy), task(), shape))
      yield* Deferred.await(promptSeen)
      yield* TestClock.adjust("7 seconds")
      yield* Deferred.succeed(release, undefined)
      const events = yield* Fiber.join(fiber)
      expect(kinds(events)).toEqual(["started", "usage", "done"])
      expect(events[1]).toMatchObject({ kind: "usage", usage: { seconds: 7 } })
    }),
  )
})
