import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { EventPayloads, type ExecutorEvent } from "@shoalwork/contracts"
import { type CodeCandidate, DEFAULT_WEIGHTS, Indexer, Ranker, RankerLive, scoreBatch } from "@shoalwork/reef"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { DEFAULT_CONTEXT_CONFIG } from "../src/context/config.js"
import { editedFiles, relativeToRoot } from "../src/edited-files.js"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  OK_EVENTS,
  specFor,
} from "./support.js"

const REPO = { url: "https://example.com/acme/app.git", base: "main" }

const candidate = (id: string, bm25: number): CodeCandidate => ({
  hit: {
    id,
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 5,
    lang: "ts",
    symbols: [],
    content: `content of ${id}`,
    score: 0.1,
    boosted: false,
  },
  raw: { bm25 },
})

const CANDIDATES = ["c1", "c2", "c3", "c4", "c5"].map((id, i) => candidate(id, 10 - i))

const indexerStub = Layer.succeed(Indexer, {
  index: () => Effect.die("not used"),
  search: () => Effect.succeed([]),
  candidates: () => Effect.succeed(CANDIDATES),
  docs: () => Effect.succeed([]),
})

const successRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{
    readonly chunk_id: string
    readonly ok: number
    readonly fail: number
  }>`SELECT chunk_id, ok, fail FROM chunk_success ORDER BY chunk_id`
})

const failing: ReadonlyArray<ExecutorEvent> = [
  { kind: "started" },
  { kind: "error", code: "max_turns", message: "reached the turn limit" },
]

describe("ranking feedback through the Lead", () => {
  it.effect("3 ok tasks and 1 failed task update chunk_success for the chunks their briefings used", () => {
    let run = 0
    const executor = fakeExecutor(() => {
      run += 1
      return eventsOf(run === 4 ? failing : OK_EVENTS)()
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      for (let i = 0; i < 4; i++) {
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe(i === 3 ? "failed" : "ok")
      }
      // The top 3 of the 5 candidates went into every briefing; c4 and c5 were considered but not used.
      expect(yield* successRows).toEqual([
        { chunk_id: "c1", ok: 3, fail: 1 },
        { chunk_id: "c2", ok: 3, fail: 1 },
        { chunk_id: "c3", ok: 3, fail: 1 },
      ])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor,
          // no retry budget: the failed run is the only attempt
          config: { minRetryBudgetMs: 10 * 60_000 },
          services: Layer.merge(indexerStub, RankerLive()),
        }),
      ),
    )
  })

  it.effect("records nothing for a task without a repo, or without a ranker", () => {
    const executor = fakeExecutor(eventsOf(OK_EVENTS))
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(spec.id)
      expect(yield* successRows).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor, services: Layer.merge(indexerStub, RankerLive()) })))
  })
})

const bigCandidate = (id: string, bm25: number): CodeCandidate => ({
  ...candidate(id, bm25),
  hit: { ...candidate(id, bm25).hit, content: `${"y".repeat(2900)}\n#${id}#` },
})

describe("chunks cut by the budget", () => {
  it.effect("are not counted against the verdict and are not marked used", () => {
    const bigIndexer = Layer.succeed(Indexer, {
      index: () => Effect.die("not used"),
      search: () => Effect.succeed([]),
      candidates: () => Effect.succeed(["b1", "b2", "b3", "b4"].map((id, i) => bigCandidate(id, 10 - i))),
      docs: () => Effect.succeed([]),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      expect((yield* lead.runOnce(spec.id)).kind).toBe("ok")
      const assembled = (yield* allEvents).find((event) => event.type === "context.assembled")
      const ranked =
        EventPayloads["context.assembled"].pipe(Schema.decodeUnknownSync)(assembled?.payload).ranked ?? []
      const used = ranked.filter((entry) => entry.used).map((entry) => entry.id)
      expect(ranked.map((entry) => entry.id)).toEqual(["b1", "b2", "b3", "b4"])
      // The light tier is squeezed to 2500 tokens: fewer chunks fit than the 3 asked for.
      expect(used.length).toBeLessThan(3)
      expect((yield* successRows).map((row) => row.chunk_id)).toEqual(used)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf(OK_EVENTS)),
          config: {
            context: { ...DEFAULT_CONTEXT_CONFIG, budget: { ...DEFAULT_CONTEXT_CONFIG.budget, light: 2500 } },
          },
          services: Layer.merge(bigIndexer, RankerLive()),
        }),
      ),
    )
  })
})

describe("active files of a retry", () => {
  it.effect(
    "a retry ranks near the files the first attempt edited, the first run only near the prompt's",
    () => {
      const seen: Array<ReadonlyArray<string>> = []
      const recordingRanker = Layer.succeed(Ranker, {
        weights: () => Effect.succeed(DEFAULT_WEIGHTS),
        rank: (candidates, ctx) =>
          Effect.sync(() => {
            seen.push(ctx.activeFiles)
            return scoreBatch(candidates, DEFAULT_WEIGHTS)
          }),
      })
      let run = 0
      const executor = fakeExecutor(() => {
        run += 1
        return run === 1
          ? eventsOf([
              { kind: "started" },
              { kind: "file_edit", path: "src/edited.ts" },
              { kind: "file_edit", path: "/elsewhere/outside.ts" },
              { kind: "error", code: "max_turns", message: "reached the turn limit" },
            ])()
          : eventsOf(OK_EVENTS)()
      })
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot, { repo: REPO, prompt: "Fix lib/util.ts" }))
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe("ok")
        expect(seen).toEqual([["lib/util.ts"], ["lib/util.ts", "src/edited.ts"]])
      }).pipe(Effect.provide(leadLayer({ executor, services: Layer.merge(indexerStub, recordingRanker) })))
    },
  )
})

describe("relativeToRoot", () => {
  it("cuts the worktree root and drops paths outside it", () => {
    expect(relativeToRoot("/work/wt/src/a.ts", "/work/wt")).toBe("src/a.ts")
    expect(relativeToRoot("src/a.ts", "/work/wt")).toBe("src/a.ts")
    expect(relativeToRoot("./src/a.ts", "/work/wt")).toBe("src/a.ts")
    expect(relativeToRoot("/elsewhere/a.ts", "/work/wt")).toBeUndefined()
    expect(relativeToRoot("../a.ts", "/work/wt")).toBeUndefined()
    expect(relativeToRoot("", "/work/wt")).toBeUndefined()
  })
})

describe("editedFiles", () => {
  it.effect("is empty for a task that edited nothing", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      expect(yield* editedFiles(beacon, spec.id, "/work")).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)) }))),
  )
})
