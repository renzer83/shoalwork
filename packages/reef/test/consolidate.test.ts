import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotId, streamIds, TaskId, type Verdict } from "@shoalwork/contracts"
import { Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { ConsolidationModel, ConsolidationModelError, consolidateTask } from "../src/consolidate.js"
import { Embedder, EmbedError } from "../src/embedder.js"
import { Reef } from "../src/reef.js"
import { EMBED_DIMS } from "../src/rows.js"
import { reefStack } from "./support.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const OTHER_TASK = Schema.decodeUnknownSync(TaskId)("task_1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const SOURCE = `task:${TASK}`
const INSTRUCTIONS = "You are the developer bot."

const VERDICT: Verdict = {
  kind: "ok",
  summary: "Built the feature",
  evidence: ["tests green"],
  cost: { tokensIn: 1, tokensOut: 1, usd: 0, seconds: 1 },
}

interface Row {
  readonly kind: string
  readonly scope: string
  readonly owner_id: string
  readonly source: string
  readonly confidence: number
  readonly content: string
  readonly superseded_by: string | null
}

const allRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<Row>`SELECT kind, scope, owner_id, source, confidence, content, superseded_by
    FROM memory_items ORDER BY id`
})

// The executor.finished the Lead writes at the end of every run: the only thing consolidation reads from the task.
const seedFinished = (taskId: typeof TASK, verdict: Verdict = VERDICT) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.append({
      streamId: streamIds.task(taskId),
      type: "executor.finished",
      payload: { taskId, botId: BOT, verdict, durationMs: 10 },
      actor: "system:lead",
      correlationId: taskId,
    })
  })

const run = (taskId: typeof TASK = TASK) =>
  consolidateTask({ taskId, botId: BOT, instructions: INSTRUCTIONS })

const answer = (text: string, calls: Array<string> = []) =>
  Layer.succeed(ConsolidationModel, {
    run: (input) =>
      Effect.sync(() => {
        calls.push(input.prompt)
      }).pipe(Effect.as(text)),
  })

const stack = (model: Layer.Layer<ConsolidationModel>) => Layer.provideMerge(model, reefStack())

const FACTS_AND_DECISION = JSON.stringify({
  summary: "Built the feature and ran the tests",
  facts: [
    { content: "The repo uses pnpm", confidence: 0.9 },
    { content: "Tests run with vitest", confidence: 0.8 },
    { content: "Possibly unused flag", confidence: 0.5 },
  ],
  decisions: ["Use Effect Schema at the edges"],
})

describe("consolidateTask", () => {
  it.effect("writes one episodic item and the facts at or above 0.7 as semantic items of the bot", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      const result = yield* run()
      expect(result).toEqual({ episodic: "written", modelOutput: "valid", semantic: 3, superseded: 0 })
      const rows = yield* allRows
      const episodic = rows.filter((row) => row.kind === "episodic")
      const semantic = rows.filter((row) => row.kind === "semantic")
      expect(episodic).toHaveLength(1)
      expect(episodic[0]).toMatchObject({
        scope: "bot",
        owner_id: BOT,
        source: SOURCE,
        confidence: 1,
        content: "Built the feature and ran the tests",
      })
      expect(semantic.map((row) => row.content).sort()).toEqual([
        "Decision: Use Effect Schema at the edges",
        "Tests run with vitest",
        "The repo uses pnpm",
      ])
      expect(semantic.every((row) => row.source === SOURCE && row.owner_id === BOT)).toBe(true)
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION)))),
  )

  it.effect("keeps only the episodic item, with the verdict summary, when the model output is invalid", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      const result = yield* run()
      expect(result).toEqual({ episodic: "written", modelOutput: "invalid", semantic: 0, superseded: 0 })
      const rows = yield* allRows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: "episodic", content: VERDICT.summary })
    }).pipe(Effect.provide(stack(answer("I think it went well, no JSON here")))),
  )

  it.effect("accepts a JSON object wrapped in prose or a code fence", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      const result = yield* run()
      expect(result.modelOutput).toBe("valid")
      expect(result.semantic).toBe(3)
    }).pipe(Effect.provide(stack(answer(`Here it is:\n\`\`\`json\n${FACTS_AND_DECISION}\n\`\`\``)))),
  )

  it.effect("supersedes a live semantic item of the bot that repeats the new fact", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      const reef = yield* Reef
      const old = yield* reef.remember({
        scope: "bot",
        ownerId: BOT,
        kind: "semantic",
        content: "The repo uses pnpm",
        source: "chat",
      })
      const result = yield* run()
      expect(result).toEqual({ episodic: "written", modelOutput: "valid", semantic: 2, superseded: 1 })
      const live = (yield* allRows).filter((row) => row.kind === "semantic" && row.superseded_by === null)
      expect(live.filter((row) => row.content === "The repo uses pnpm")).toHaveLength(1)
      const chain = yield* reef.history(old.id)
      expect(chain.map((item) => item.content)).toEqual(["The repo uses pnpm", "The repo uses pnpm"])
      expect(chain[0]?.id).toBe(old.id)
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION)))),
  )

  it.effect("does not supersede a fact that only matches an item of another bot", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      const reef = yield* Reef
      yield* reef.remember({
        scope: "bot",
        ownerId: "bot_0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        kind: "semantic",
        content: "The repo uses pnpm",
        source: "chat",
      })
      const result = yield* run()
      expect(result.superseded).toBe(0)
      expect(result.semantic).toBe(3)
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION)))),
  )

  it.effect("writes the episodic item once when the same task is consolidated again", () =>
    Effect.gen(function* () {
      yield* seedFinished(TASK)
      yield* run()
      const second = yield* run()
      expect(second.episodic).toBe("exists")
      const rows = yield* allRows
      expect(rows.filter((row) => row.kind === "episodic")).toHaveLength(1)
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION)))),
  )

  it.effect("skips a task that has no executor.finished and never calls the model", () => {
    const calls: Array<string> = []
    return Effect.gen(function* () {
      yield* seedFinished(OTHER_TASK)
      const result = yield* run(TASK)
      expect(result).toEqual({ episodic: "skipped", modelOutput: "none", semantic: 0, superseded: 0 })
      expect(calls).toHaveLength(0)
      expect(yield* allRows).toHaveLength(0)
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION, calls))))
  })

  it.effect("sends the bot instructions and the events of the task to the model, as data", () => {
    const calls: Array<string> = []
    return Effect.gen(function* () {
      yield* seedFinished(TASK)
      yield* run()
      expect(calls).toHaveLength(1)
      const prompt = calls[0] ?? ""
      expect(prompt).toContain(INSTRUCTIONS)
      expect(prompt).toContain("executor.finished:")
      expect(prompt).toContain("Built the feature")
    }).pipe(Effect.provide(stack(answer(FACTS_AND_DECISION, calls))))
  })

  it.effect("a failing model fails the consolidation and writes nothing", () => {
    const failing = Layer.succeed(ConsolidationModel, {
      run: () => Effect.fail(new ConsolidationModelError({ detail: "model down" })),
    })
    return Effect.gen(function* () {
      yield* seedFinished(TASK)
      const exit = yield* Effect.exit(run())
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* allRows).toHaveLength(0)
    }).pipe(Effect.provide(stack(failing)))
  })

  it.effect(
    "an embedder that is down fails the consolidation and writes nothing, so the queue can retry it",
    () => {
      const down = Layer.succeed(Embedder, {
        dims: EMBED_DIMS,
        embed: () => Effect.fail(new EmbedError({ reason: "transport", detail: "ollama is down" })),
      })
      return Effect.gen(function* () {
        yield* seedFinished(TASK)
        const exit = yield* Effect.exit(run())
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* allRows).toHaveLength(0)
      }).pipe(Effect.provide(Layer.provideMerge(answer(FACTS_AND_DECISION), reefStack(down))))
    },
  )
})
