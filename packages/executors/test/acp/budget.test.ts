import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { startFakeAgent, update } from "./fake-agent.js"
import { collect, executorWith, fakePolicy, kinds, runAgent, tankServing, task } from "./harness.js"

const { policy } = fakePolicy({})

describe("acp budget", () => {
  it.effect("the cost the agent reports cuts the run when it passes the usd budget", () =>
    Effect.gen(function* () {
      const { events, agent } = yield* runAgent(
        {
          onPrompt: async (call) => {
            await update(call, {
              sessionUpdate: "usage_update",
              used: 1,
              size: 10,
              cost: { amount: 1.5, currency: "USD" },
            })
            await update(call, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late" },
            })
            return { stopReason: "end_turn" }
          },
        },
        policy,
        task({ budget: { tokens: 1000, seconds: 600, usd: 1 } }),
      )
      expect(kinds(events)).toEqual(["started", "usage", "error"])
      expect(events.at(-1)).toEqual({ kind: "error", code: "budget", message: "usd budget exceeded" })
      expect(agent.state.killed).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("the tokens of the final usage are checked against the token budget", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(
        {
          onPrompt: async () => ({
            stopReason: "end_turn",
            usage: { totalTokens: 60, inputTokens: 50, outputTokens: 10 },
          }),
        },
        policy,
        task({ budget: { tokens: 20, seconds: 600, usd: 1 } }),
      )
      expect(kinds(events)).toEqual(["started", "usage", "error"])
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "budget" })
    }),
  )

  it.effect("a dead agent whose exit code never arrives is reported after a bounded wait", () =>
    Effect.gen(function* () {
      const died = yield* Deferred.make<void>()
      const exit: { current: Effect.Effect<void> } = { current: Effect.void }
      const agent = yield* startFakeAgent({
        onPrompt: () =>
          Effect.runPromise(exit.current).then(() => {
            Deferred.doneUnsafe(died, Effect.void)
            return new Promise<never>(() => undefined)
          }),
      })
      exit.current = agent.proc.kill()
      const stuck = { ...agent, proc: { ...agent.proc, exitCode: Effect.never } }
      const fiber = yield* Effect.forkChild(collect(executorWith(policy), task(), tankServing(stuck).shape))
      yield* Deferred.await(died)
      // The wait is registered after the connection fails; step the clock until it has passed.
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, i) => i),
        () =>
          TestClock.adjust("1 second").pipe(
            Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
          ),
      )
      const events = yield* Fiber.join(fiber)
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "unknown",
        message: "acp-fake exited with code -1 without a result",
      })
    }),
  )
})
