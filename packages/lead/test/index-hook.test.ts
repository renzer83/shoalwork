import { it } from "@effect/vitest"
import { type ExecutorEvent, type RepoRef, repoKeyOf } from "@shoalwork/contracts"
import type { Executor, ExecutorContext } from "@shoalwork/executors"
import { Indexer, type IndexReport, WalkError } from "@shoalwork/reef"
import { Deferred, Duration, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { INDEX_QUEUE, startIndexHook } from "../src/hooks/index-repo.js"
import { Lead, type LeadConfig } from "../src/index.js"
import { createBot, eventsOf, fakeExecutor, leadLayer, makeFakeTank, OK_EVENTS, specFor } from "./support.js"

const HOOK = { pollMs: 10, heartbeatMs: 1_000 } as const
const TIMEOUT_MS = 15_000
const SERVER = { serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js", api: "http://127.0.0.1:28900" }
const HTTPS = "https://github.com/renzer83/shoalwork.git"
const SSH = "ssh://git@github.com/renzer83/shoalwork.git"
const SCP = "git@github.com:renzer83/shoalwork.git"
const REPO_KEY = "github.com/renzer83/shoalwork"
const REPO: RepoRef = { url: HTTPS, base: "main" }
const FAILING: ReadonlyArray<ExecutorEvent> = [{ kind: "error", code: "protocol", message: "pipe closed" }]

const SEEDED_CHUNKS = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* seedChunks(sql, REPO_KEY)
})

const seedChunks = (sql: SqlClient, repo: string) =>
  sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at)
    VALUES ('chunk-seed', ${repo}, 'src/a.ts', 1, 3, 'hash', 'ts', '[]', 'export const a = 1', '2026-10-20T00:00:00.000Z')`

const chunkCount = (repo: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly n: number
    }>`SELECT count(*) AS n FROM code_chunks WHERE repo = ${repo}`
    return rows[0]?.n ?? 0
  })

const indexJobs = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{ readonly state: string; readonly attempts: number; readonly payload: string }>`
    SELECT state, attempts, payload FROM jobs WHERE queue = ${INDEX_QUEUE} ORDER BY id`
})

// Waits (bounded by the test timeout) until the check holds.
const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep(Duration.millis(10))
    }
  })

// Indexer stand-in: the same repo id rule as the real one (repoKeyOf of the url), and it stores one chunk for it.
const fakeIndexer = (opts: { readonly fail?: boolean; readonly gate?: Deferred.Deferred<void> } = {}) => {
  const urls: Array<string> = []
  const layer = Layer.effect(
    Indexer,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      return {
        index: (_dir, options) =>
          Effect.gen(function* () {
            urls.push(options?.repoUrl ?? "")
            if (opts.gate !== undefined) {
              yield* Deferred.await(opts.gate)
            }
            if (opts.fail === true) {
              return yield* Effect.fail(new WalkError({ reason: "git", detail: "boom" }))
            }
            const repo = repoKeyOf(options?.repoUrl ?? "")
            yield* sql`DELETE FROM code_chunks WHERE repo = ${repo}`
            yield* seedChunks(sql, repo)
            const report: IndexReport = {
              repo,
              files: 1,
              filesChanged: 1,
              filesRemoved: 0,
              chunks: 1,
              chunksEmbedded: 1,
              chunksReused: 0,
              failed: [],
            }
            return report
          }),
        search: () => Effect.succeed([]),
        candidates: () => Effect.succeed([]),
        docs: () => Effect.succeed([]),
      }
    }),
  )
  return { layer, urls }
}

const stack = (
  executor: Executor,
  indexer: Layer.Layer<Indexer, never, SqlClient>,
  config: Partial<LeadConfig> = {},
) => Layer.provideMerge(indexer, leadLayer({ executor, tank: makeFakeTank(), config }))

const recordingExecutor = (
  contexts: Array<ExecutorContext>,
  events: ReadonlyArray<ExecutorEvent> = OK_EVENTS,
) => {
  const base = fakeExecutor(eventsOf(events))
  return {
    ...base,
    run: (_task: Parameters<Executor["run"]>[0], ctx: ExecutorContext) => {
      contexts.push(ctx)
      return eventsOf(events)()
    },
  }
}

describe("index job after a code task", () => {
  it.live(
    "a code task with a repo that ends ok queues one index job, which indexes the repo under its url key",
    () => {
      const indexer = fakeIndexer()
      return Effect.gen(function* () {
        yield* SEEDED_CHUNKS
        yield* startIndexHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        expect(yield* lead.runOnce(spec.id)).toMatchObject({ kind: "ok" })
        yield* until(Effect.map(indexJobs, (jobs) => jobs.length === 1 && jobs[0]?.state === "done"))
        expect(indexer.urls).toEqual([HTTPS])
        expect((yield* lead.get(spec.id)).state).toBe("done")
      }).pipe(Effect.scoped, Effect.provide(stack(fakeExecutor(eventsOf(OK_EVENTS)), indexer.layer)))
    },
    TIMEOUT_MS,
  )

  it.live("a code task that ends blocked queues no index job", () =>
    Effect.gen(function* () {
      yield* SEEDED_CHUNKS
      yield* startIndexHook(HOOK)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      expect(yield* lead.runOnce(spec.id)).toMatchObject({ kind: "blocked" })
      yield* Effect.sleep(Duration.millis(200))
      expect(yield* indexJobs).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(stack(fakeExecutor(eventsOf(FAILING)), fakeIndexer().layer))),
  )

  it.live(
    "a run that starts on a repo with no indexed chunks queues an index, and none once the repo is indexed",
    () => {
      const indexer = fakeIndexer()
      return Effect.gen(function* () {
        yield* startIndexHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const first = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(first.id)
        yield* until(Effect.map(chunkCount(REPO_KEY), (n) => n > 0))
        const before = (yield* indexJobs).length
        expect(before).toBeGreaterThanOrEqual(1)
        const second = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(second.id)
        yield* Effect.sleep(Duration.millis(200))
        expect((yield* indexJobs).length).toBe(before)
      }).pipe(Effect.scoped, Effect.provide(stack(fakeExecutor(eventsOf(FAILING)), indexer.layer)))
    },
    TIMEOUT_MS,
  )

  it.live("a failing index job leaves the finished task done", () =>
    Effect.gen(function* () {
      yield* SEEDED_CHUNKS
      yield* startIndexHook(HOOK)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      expect(yield* lead.runOnce(spec.id)).toMatchObject({ kind: "ok" })
      yield* until(Effect.map(indexJobs, (jobs) => (jobs[0]?.attempts ?? 0) >= 1))
      expect((yield* lead.get(spec.id)).state).toBe("done")
    }).pipe(
      Effect.scoped,
      Effect.provide(stack(fakeExecutor(eventsOf(OK_EVENTS)), fakeIndexer({ fail: true }).layer)),
    ),
  )

  it.live(
    "after the index job, the reef server is attached to a run on the same repo under the https, ssh and scp forms",
    () => {
      const contexts: Array<ExecutorContext> = []
      // The index job is held at a gate the test controls, so "nothing indexed yet" holds however slow the run setup is.
      const gate = Deferred.makeUnsafe<void>()
      const indexer = fakeIndexer({ gate })
      return Effect.gen(function* () {
        yield* startIndexHook(HOOK)
        const lead = yield* Lead
        const bot = yield* createBot
        const first = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(first.id)
        // Before anything is indexed the run gets no reef server.
        expect(contexts[0]?.mcp).toBeUndefined()
        yield* Deferred.succeed(gate, undefined)
        yield* until(Effect.map(chunkCount(REPO_KEY), (n) => n > 0))
        for (const url of [HTTPS, SSH, SCP]) {
          const next = yield* lead.intake(specFor(bot, { repo: { url, base: "main" } }))
          yield* lead.runOnce(next.id)
          expect(contexts.at(-1)?.mcp).toEqual({
            serverEntry: SERVER.serverEntry,
            repo: REPO_KEY,
            bot: bot.id,
            api: SERVER.api,
          })
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(stack(recordingExecutor(contexts), indexer.layer, { mcp: SERVER })),
      )
    },
    TIMEOUT_MS,
  )
})
