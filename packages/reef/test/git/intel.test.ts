import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import { blameSummary, GitIntelError, recentChanges, relatedDiffs } from "../../src/git/intel.js"
import { runGit } from "../../src/git/run.js"

const DAY = 86_400_000
const dirs: Array<string> = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Step {
  readonly who: "Ana" | "Bruno"
  readonly daysAgo: number
  readonly subject: string
  readonly files: Readonly<Record<string, string>>
}

// A throwaway repository: one commit per step, with the author, the date and the files the step writes.
const buildRepo = (steps: ReadonlyArray<Step>): string => {
  const dir = mkdtempSync(join(tmpdir(), "reef-git-"))
  dirs.push(dir)
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
  for (const step of steps) {
    for (const [rel, content] of Object.entries(step.files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), content)
    }
    execFileSync("git", ["-C", dir, "add", "-A"])
    const when = new Date(Date.now() - step.daysAgo * DAY).toISOString()
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", step.subject], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: step.who,
        GIT_AUTHOR_EMAIL: `${step.who.toLowerCase()}@example.invalid`,
        GIT_COMMITTER_NAME: step.who,
        GIT_COMMITTER_EMAIL: `${step.who.toLowerCase()}@example.invalid`,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    })
  }
  return dir
}

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")

// Five commits: the first is outside a 30-day window, the others spread over the last two weeks.
const FIVE: ReadonlyArray<Step> = [
  { who: "Ana", daysAgo: 40, subject: "first a", files: { "src/a.ts": "export const a = 1\n" } },
  {
    who: "Bruno",
    daysAgo: 3,
    subject: "second a and b",
    files: { "src/a.ts": "export const a = 2\n", "src/b.ts": "b\n" },
  },
  { who: "Ana", daysAgo: 2, subject: "third b", files: { "src/b.ts": "b2\n" } },
  { who: "Bruno", daysAgo: 1, subject: "bracket file", files: { "src/[id].ts": "id\n" } },
  { who: "Ana", daysAgo: 0, subject: "fifth a", files: { "src/a.ts": "export const a = 3\n" } },
]

describe("recentChanges", () => {
  it.effect("keeps only the commits that touch the given paths inside the window", () =>
    Effect.gen(function* () {
      const repo = buildRepo(FIVE)
      const commits = yield* recentChanges(repo, ["src/a.ts"], 7)
      expect(commits.map((commit) => commit.subject)).toEqual(["fifth a", "second a and b"])
      expect(commits[1]?.files).toEqual(["src/a.ts"])
      expect(commits[0]?.author).toBe("Ana")
      const wider = yield* recentChanges(repo, ["src/b.ts"], 30)
      expect(wider.map((commit) => commit.subject)).toEqual(["third b", "second a and b"])
      expect(yield* recentChanges(repo, [], 7)).toEqual([])
    }),
  )

  it.effect("reads paths literally: a name with brackets is not a glob", () =>
    Effect.gen(function* () {
      const repo = buildRepo(FIVE)
      const commits = yield* recentChanges(repo, ["src/[id].ts"], 7)
      expect(commits.map((commit) => commit.subject)).toEqual(["bracket file"])
      expect(commits[0]?.files).toEqual(["src/[id].ts"])
    }),
  )

  it.effect("redacts a subject that looks like a secret and never reports e-mail addresses", () => {
    const token = ["sk", "ant", "a".repeat(24)].join("-")
    const repo = buildRepo([
      { who: "Ana", daysAgo: 0, subject: `rotate ${token}`, files: { "src/a.ts": "x\n" } },
    ])
    return Effect.gen(function* () {
      const [commit] = yield* recentChanges(repo, ["src/a.ts"], 7)
      expect(commit?.subject).toBe("[redacted]")
      expect(JSON.stringify(commit)).not.toContain("@example.invalid")
    })
  })

  it.effect("fails with a typed error when git cannot read the directory", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(recentChanges("/nonexistent-reef-dir", ["src/a.ts"], 7))
      expect(error).toBeInstanceOf(GitIntelError)
      expect(error.reason).toBe("exit")
    }),
  )
})

describe("relatedDiffs", () => {
  it.effect("cuts each patch to maxLines by whole hunks, keeping the newest commit first", () =>
    Effect.gen(function* () {
      const big = lines(300, "row")
      const repo = buildRepo([
        { who: "Ana", daysAgo: 2, subject: "add rows", files: { "src/big.ts": `${big}\n` } },
        {
          who: "Bruno",
          daysAgo: 1,
          subject: "touch one row",
          files: { "src/big.ts": `${big.replace("row 5", "row five")}\n` },
        },
      ])
      const short = yield* relatedDiffs(repo, ["src/big.ts"], 10)
      expect(short).toHaveLength(2)
      for (const diff of short) {
        expect(diff.patch.split("\n").length).toBeLessThanOrEqual(10)
        expect(diff.path).toBe("src/big.ts")
      }
      const full = yield* relatedDiffs(repo, ["src/big.ts"], 1000)
      expect(full[1]?.patch).toContain("+row 300")
    }),
  )
})

describe("blameSummary", () => {
  it.effect("counts the lines of a file per author, without e-mail addresses", () =>
    Effect.gen(function* () {
      const repo = buildRepo([
        { who: "Ana", daysAgo: 5, subject: "start", files: { "src/a.ts": `${lines(3, "ana")}\n` } },
        {
          who: "Bruno",
          daysAgo: 1,
          subject: "extend",
          files: { "src/a.ts": `${lines(3, "ana")}\n${lines(2, "bruno")}` },
        },
      ])
      const summary = yield* blameSummary(repo, "src/a.ts")
      expect(summary.authors).toEqual([
        { name: "Ana", lines: 3 },
        { name: "Bruno", lines: 2 },
      ])
      expect(summary.lastChange).not.toBe("")
      expect(JSON.stringify(summary)).not.toContain("@")
    }),
  )
})

describe("runGit", () => {
  it.effect("returns the output of a successful call", () =>
    Effect.gen(function* () {
      const repo = buildRepo(FIVE)
      const out = yield* runGit(repo, ["rev-list", "--count", "HEAD"])
      expect(out.trim()).toBe("5")
    }),
  )
})
