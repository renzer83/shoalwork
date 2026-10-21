import { execFileSync } from "node:child_process"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Indexer } from "../../src/indexer/indexer.js"
import { RANK_CANDIDATES } from "../../src/indexer/search.js"
import { lastCommitIso } from "../../src/indexer/walk.js"
import { rankCode } from "../../src/rank/code.js"
import { Ranker, RankerLive } from "../../src/rank/ranker.js"
import { recencySignal } from "../../src/rank/signals.js"
import type { FixtureRepo } from "../fixtures/repo/files.js"
import { APP_TS, writeInRepo } from "../fixtures/repo/files.js"
import { indexerEnv, withFixtureRepo } from "../indexer/helpers.js"

const DAY_MS = 86_400_000

const commit = (repo: FixtureRepo, whenMs: number): void => {
  const date = new Date(whenMs).toISOString()
  execFileSync(
    "git",
    ["-c", "user.name=tester", "-c", "user.email=tester@example.invalid", "commit", "-q", "-m", "snapshot"],
    {
      cwd: repo.dir,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  )
}

const commitTimes = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{
    readonly path: string
    readonly last_commit_at: string | null
  }>`SELECT DISTINCT path, last_commit_at FROM code_chunks ORDER BY path`
  return new Map(rows.map((row) => [row.path, row.last_commit_at]))
})

const env = Layer.provideMerge(RankerLive(), indexerEnv())

describe("last_commit_at", () => {
  it.live("is filled from git log when a file is indexed, and stays null for an uncommitted file", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const when = Math.floor((Date.now() - 3 * DAY_MS) / 1000) * 1000
        commit(repo, when)
        writeInRepo(repo, "src/fresh.ts", "export const fresh = 1\n")
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        const times = yield* commitTimes
        expect(times.get("src/app.ts")).toBe(new Date(when).toISOString())
        // "" = git was asked and has no commit for it
        expect(times.get("src/fresh.ts")).toBe("")
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.live("is filled on a later run for rows indexed before it was recorded", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        // Rows written before the column existed have NULL.
        const sql = yield* SqlClient
        yield* sql`UPDATE code_chunks SET last_commit_at = NULL`
        expect((yield* commitTimes).get("src/app.ts")).toBeNull()
        const when = Math.floor((Date.now() - DAY_MS) / 1000) * 1000
        commit(repo, when)
        const report = yield* indexer.index(repo.dir)
        expect(report.filesChanged).toBe(0)
        expect((yield* commitTimes).get("src/app.ts")).toBe(new Date(when).toISOString())
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )
})

describe("files git has no commit for", () => {
  it.live("are asked about once: a later run does not ask git again", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.index(repo.dir)
        expect((yield* commitTimes).get("src/app.ts")).toBe("")
        commit(repo, Date.now() - DAY_MS)
        yield* indexer.index(repo.dir)
        // Unchanged since it was marked: git is not asked again, so the marker stays until the file changes.
        expect((yield* commitTimes).get("src/app.ts")).toBe("")
        writeInRepo(repo, "src/app.ts", `${APP_TS}\nexport const more = 1\n`)
        yield* indexer.index(repo.dir)
        expect((yield* commitTimes).get("src/app.ts")).not.toBe("")
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.live("a marker is no recency: candidates of such a file have none", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        const found = yield* indexer.candidates(id, "compute")
        expect(found.length).toBeGreaterThan(0)
        expect(found.every((candidate) => candidate.raw.recency === undefined)).toBe(true)
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )
})

describe("Indexer.candidates", () => {
  it.live("returns the raw signals the search measured", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const when = Math.floor((Date.now() - 3 * DAY_MS) / 1000) * 1000
        commit(repo, when)
        const indexer = yield* Indexer
        const { repo: id } = yield* indexer.index(repo.dir)
        const candidates = yield* indexer.candidates(id, "compute")
        const top = candidates.find((candidate) => candidate.hit.path === "src/lib.rs")
        expect(top?.raw.bm25).toBeGreaterThan(0)
        expect(top?.raw.cosine).toBeGreaterThan(-1.0001)
        expect(top?.raw.recency).toBeCloseTo(recencySignal(3), 1)
        expect(candidates.length).toBeLessThanOrEqual(RANK_CANDIDATES)
        // a chunk the text search did not find has no bm25
        expect(candidates.some((candidate) => candidate.raw.bm25 === undefined)).toBe(true)
        expect((yield* indexer.candidates(id, "compute", 2)).length).toBe(2)
        expect(yield* indexer.candidates(id, "!!!")).toEqual([])
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )
})

describe("rankCode", () => {
  it.live("re-scores the candidates and reports which made the cut", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        commit(repo, Date.now() - DAY_MS)
        const indexer = yield* Indexer
        const ranker = yield* Ranker
        const { repo: id } = yield* indexer.index(repo.dir)
        const candidates = yield* indexer.candidates(id, "alpha compute load")
        const ranked = yield* rankCode(
          ranker,
          candidates,
          { repo: id, activeFiles: ["tools/util.py"], query: "x" },
          2,
        )
        expect(ranked.hits).toHaveLength(2)
        expect(ranked.considered).toHaveLength(candidates.length)
        expect(ranked.considered.filter((entry) => entry.used)).toHaveLength(2)
        // the file named as active outranks the others on proximity
        expect(ranked.hits[0]?.path).toBe("tools/util.py")
        expect(ranked.hits[0]?.score).toBeGreaterThanOrEqual(ranked.hits[1]?.score ?? 0)
      }),
    ).pipe(Effect.provide(env)),
  )
})

describe("lastCommitIso", () => {
  it.live("reads a path literally: [id].ts is not a glob", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const git = (...args: Array<string>) =>
          execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
            cwd: repo.dir,
            stdio: "ignore",
            env: { ...process.env, GIT_AUTHOR_DATE: dateOf, GIT_COMMITTER_DATE: dateOf },
          })
        let dateOf = "2026-01-01T00:00:00Z"
        writeInRepo(repo, "pages/[id].ts", "export const page = 1\n")
        git("add", "pages/[id].ts")
        git("commit", "-q", "-m", "page")
        dateOf = "2026-02-01T00:00:00Z"
        writeInRepo(repo, "pages/d.ts", "export const d = 1\n")
        git("add", "pages/d.ts")
        git("commit", "-q", "-m", "d")
        // As a glob, "[id].ts" would also match d.ts and answer with the later commit.
        expect(yield* lastCommitIso(repo.dir, "pages/[id].ts")).toBe("2026-01-01T00:00:00.000Z")
        expect(yield* lastCommitIso(repo.dir, "pages/*.ts")).toBeUndefined()
      }),
    ),
  )
})
