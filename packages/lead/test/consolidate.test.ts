import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import type { ExecutorEvent, TaskId } from "@shoalwork/contracts"
import type { Executor } from "@shoalwork/executors"
import { ConsolidationModel, EmbedderTest, ReefLive } from "@shoalwork/reef"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { executorConsolidationModel, startConsolidateHook } from "../src/hooks/consolidate.js"
import { Lead } from "../src/index.js"
import {
  createBot,
  fakeExecutor,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  specFor,
  TEST_TIERS,
} from "./support.js"

const HOOK = { pollMs: 10, heartbeatMs: 1_000 } as const
const TIMEOUT_MS = 15_000

const GOOD_ANSWER = JSON.stringify({
  summary: "Added the feature",
  facts: [
    { content: "The repo uses pnpm", confidence: 0.9 },
    { content: "A guess", confidence: 0.3 },
  ],
  decisions: [],
})

// The light run is recognised by its prompt; the task itself runs the ordinary OK stream.
const isConsolidation = (prompt: string): boolean => prompt.includes("You consolidate the memory")

const executorAnswering = (consolidation: ReadonlyArray<ExecutorEvent>): Executor =>
  fakeExecutor((task) => Stream.fromIterable(isConsolidation(task.prompt) ? consolidation : OK_EVENTS))

const answer = (text: string): ReadonlyArray<ExecutorEvent> => [
  {
    kind: "usage",
    usage: { tokensIn: 40, tokensOut: 20, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 1 },
  },
  { kind: "done", result: text, artifacts: [] },
]

// Lead over a fresh database, the Reef and the deterministic embedder over the same connection, and the light model.
const stack = (executor: Executor, tank = makeFakeTank()) => {
  const lead = leadLayer({ executor, tank })
  const reef = Layer.provideMerge(ReefLive(), Layer.provideMerge(EmbedderTest, lead))
  return Layer.provideMerge(executorConsolidationModel(TEST_TIERS), reef)
}

const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const memoryRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{ readonly kind: string; readonly content: string; readonly source: string }>`
    SELECT kind, content, source FROM memory_items ORDER BY id`
})

const consolidateJobs = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{ readonly state: string; readonly attempts: number }>`
    SELECT state, attempts FROM jobs WHERE queue = 'consolidate' ORDER BY id`
})

const taskEventsOf = (taskId: TaskId) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* Stream.runCollect(beacon.readStream(`task:${taskId}`))
  })

const ErrorPayload = Schema.Struct({ where: Schema.String })
const whereOf = (payload: unknown): string => Schema.decodeUnknownSync(ErrorPayload)(payload).where

describe("consolidation of a finished task", () => {
  it.live(
    "a done task gets one episodic item and its confident facts, in the background",
    () =>
      Effect.gen(function* () {
        yield* startConsolidateHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe("ok")
        yield* until(Effect.map(memoryRows, (rows) => rows.length >= 2))
        const rows = yield* memoryRows
        expect(rows.map((row) => row.kind).sort()).toEqual(["episodic", "semantic"])
        expect(rows.find((row) => row.kind === "episodic")?.content).toBe("Added the feature")
        expect(rows.find((row) => row.kind === "semantic")?.content).toBe("The repo uses pnpm")
        expect(rows.every((row) => row.source === `task:${spec.id}`)).toBe(true)
        yield* until(Effect.map(consolidateJobs, (jobs) => jobs[0]?.state === "done"))
        expect((yield* lead.get(spec.id)).state).toBe("done")
      }).pipe(Effect.scoped, Effect.provide(stack(executorAnswering(answer(GOOD_ANSWER))))),
    TIMEOUT_MS,
  )

  it.live(
    "a model answer that is not JSON keeps only the episodic item",
    () =>
      Effect.gen(function* () {
        yield* startConsolidateHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        yield* lead.runOnce(spec.id)
        yield* until(Effect.map(consolidateJobs, (jobs) => jobs[0]?.state === "done"))
        const rows = yield* memoryRows
        expect(rows.map((row) => row.kind)).toEqual(["episodic"])
        expect((yield* lead.get(spec.id)).state).toBe("done")
      }).pipe(Effect.scoped, Effect.provide(stack(executorAnswering(answer("no json at all"))))),
    TIMEOUT_MS,
  )

  it.live(
    "a consolidation that fails twice records error.raised and leaves the task done",
    () =>
      Effect.gen(function* () {
        yield* startConsolidateHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        yield* lead.runOnce(spec.id)
        yield* until(
          Effect.map(taskEventsOf(spec.id), (events) =>
            events.some(
              (event) => event.type === "error.raised" && whereOf(event.payload) === "reef.consolidate",
            ),
          ),
        )
        const jobs = yield* consolidateJobs
        expect(jobs).toEqual([{ state: "failed", attempts: 2 }])
        expect(yield* memoryRows).toHaveLength(0)
        expect((yield* lead.get(spec.id)).state).toBe("done")
      }).pipe(
        Effect.scoped,
        Effect.provide(stack(executorAnswering([{ kind: "error", code: "unknown", message: "boom" }]))),
      ),
    TIMEOUT_MS,
  )
})

describe("executorConsolidationModel", () => {
  it.effect(
    "runs the light tier once, returns the done text, records usage and releases the tank context",
    () => {
      const tank = makeFakeTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        const model = yield* ConsolidationModel
        const text = yield* model.run({
          botId: bot.id,
          taskId: spec.id,
          prompt: "You consolidate the memory of x",
        })
        expect(text).toBe(GOOD_ANSWER)
        expect(tank.prepared).toHaveLength(1)
        expect(tank.released).toEqual([{ keepWorktree: false }])
        const events = yield* taskEventsOf(spec.id)
        expect(events.filter((event) => event.type === "usage.recorded")).toHaveLength(1)
      }).pipe(Effect.provide(stack(executorAnswering(answer(GOOD_ANSWER)), tank)))
    },
  )

  it.effect("fails with the executor's error when the light run ends with an error event", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const model = yield* ConsolidationModel
      const exit = yield* Effect.exit(
        model.run({ botId: bot.id, taskId: spec.id, prompt: "You consolidate the memory of x" }),
      )
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(stack(executorAnswering([{ kind: "error", code: "unknown", message: "boom" }])))),
  )
})
