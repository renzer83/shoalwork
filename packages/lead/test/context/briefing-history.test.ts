import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { it } from "@effect/vitest"
import type { DocHit } from "@shoalwork/reef"
import type { TankContext } from "@shoalwork/tank"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import type { BriefingDocs } from "../../src/context/briefing.js"
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "../../src/context/config.js"
import { estimateTokens } from "../../src/context/tokens.js"
import { build, files, repo, withSpec, worktreeCtx } from "./briefing-support.js"

const DAY = 86_400_000
const dirs: Array<string> = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Step {
  readonly who: string
  readonly daysAgo: number
  readonly subject: string
  readonly files: Readonly<Record<string, string>>
}

// A throwaway repository with one commit per step, dated in the past.
const repoWith = (steps: ReadonlyArray<Step>): string => {
  const dir = mkdtempSync(join(tmpdir(), "lead-history-"))
  dirs.push(dir)
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
  for (const step of steps) {
    for (const [rel, content] of Object.entries(step.files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), content)
    }
    execFileSync("git", ["-C", dir, "add", "-A"])
    const when = new Date(Date.now() - step.daysAgo * DAY).toISOString()
    const author = { GIT_AUTHOR_NAME: step.who, GIT_COMMITTER_NAME: step.who }
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", step.subject], {
      env: {
        ...process.env,
        ...author,
        GIT_AUTHOR_EMAIL: `${step.who.toLowerCase()}@example.invalid`,
        GIT_COMMITTER_EMAIL: `${step.who.toLowerCase()}@example.invalid`,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    })
  }
  return dir
}

const gitCtx = (dir: string): TankContext => ({
  ...worktreeCtx,
  worktree: { path: dir, branch: "bot/dev-demo/step", repoDir: dir },
})

const codeTask = (prompt: string) => withSpec({ kind: "code", repo, tier: "heavy", prompt })

const DOC_HIT: DocHit = {
  symbol: "recentChanges",
  path: "docs/git.md",
  heading: "Git intel",
  excerpt: "`recentChanges` lists the commits of the last days that touched a path.",
}

// Records the symbols it was asked for; answers with the one hit.
const fixtureDocs = () => {
  const calls: Array<ReadonlyArray<string>> = []
  const docs: BriefingDocs = (_repo, symbols) =>
    Effect.sync(() => {
      calls.push(symbols)
      return [DOC_HIT]
    })
  return { docs, calls }
}

// The text of one briefing section: from its heading to the next top-level heading (or the end).
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ""
  const next = text.indexOf("\n# ", start + heading.length)
  return next < 0 ? text.slice(start) : text.slice(start, next)
}

const GIT_HEADING = "# Recent changes to these files"
const DOCS_HEADING = "# Documentation of these symbols"

describe("buildBriefing with the git and docs blocks", () => {
  it.effect("adds the recent commits of the task's files and the docs of its symbols, in that order", () =>
    Effect.gen(function* () {
      const dir = repoWith([
        {
          who: "Ana",
          daysAgo: 4,
          subject: "first change",
          files: { "src/a.ts": "export const alpha = 1\n" },
        },
        {
          who: "Bruno",
          daysAgo: 1,
          subject: "second change",
          files: { "src/a.ts": "export const alpha = 2\n" },
        },
      ])
      const { docs, calls } = fixtureDocs()
      const briefing = yield* build(
        codeTask("Fix src/a.ts and check `recentChanges` before you change it"),
        { docs, tank: files({ "src/a.ts": "export const alpha = 2\n" }) },
        gitCtx(dir),
      )
      expect(briefing.text).toContain(GIT_HEADING)
      expect(briefing.text).toContain("second change")
      expect(briefing.text).toContain("Bruno")
      expect(briefing.text).not.toContain("@example.invalid")
      expect(briefing.text).toContain(DOCS_HEADING)
      expect(briefing.text).toContain("docs/git.md")
      expect(calls[0]).toEqual(expect.arrayContaining(["recentChanges", "alpha"]))
      expect(briefing.text.indexOf(GIT_HEADING)).toBeLessThan(briefing.text.indexOf(DOCS_HEADING))
    }),
  )

  it.effect("keeps the git block inside its cap, trimming the diffs first", () => {
    const big = Array.from({ length: 300 }, (_, index) => `row ${index + 1} ${"x".repeat(20)}`).join("\n")
    const dir = repoWith([
      { who: "Ana", daysAgo: 3, subject: "add rows", files: { "src/big.ts": `${big}\n` } },
      {
        who: "Bruno",
        daysAgo: 1,
        subject: "touch rows",
        files: { "src/big.ts": `${big.replace("row 5 ", "row five ")}\n` },
      },
    ])
    const config: ContextConfig = {
      ...DEFAULT_CONTEXT_CONFIG,
      blocks: { ...DEFAULT_CONTEXT_CONFIG.blocks, git: 300 },
    }
    return Effect.gen(function* () {
      const briefing = yield* build(
        codeTask("Refactor src/big.ts"),
        { tank: files({}) },
        gitCtx(dir),
        { complexity: 3 },
        config,
      )
      const block = section(briefing.text, GIT_HEADING)
      expect(block).toContain("touch rows")
      expect(estimateTokens(block)).toBeLessThanOrEqual(300)
    })
  })

  it.effect("reports a failing docs search and still builds the briefing with the history", () =>
    Effect.gen(function* () {
      const dir = repoWith([{ who: "Ana", daysAgo: 1, subject: "only change", files: { "src/a.ts": "x\n" } }])
      const reported: Array<string> = []
      const briefing = yield* build(
        codeTask("Fix src/a.ts and check `recentChanges`"),
        {
          docs: () => Effect.fail("index down"),
          tank: files({}),
          onSourceError: (source) =>
            Effect.sync(() => {
              reported.push(source)
            }),
        },
        gitCtx(dir),
      )
      expect(reported).toEqual(["docs"])
      expect(briefing.text).toContain("only change")
      expect(briefing.text).not.toContain(DOCS_HEADING)
    }),
  )

  it.effect("reports a failing history and still builds the briefing with the docs", () =>
    Effect.gen(function* () {
      const reported: Array<string> = []
      const { docs } = fixtureDocs()
      const briefing = yield* build(
        codeTask("Fix src/a.ts and check `recentChanges`"),
        {
          docs,
          tank: files({}),
          onSourceError: (source) =>
            Effect.sync(() => {
              reported.push(source)
            }),
        },
        gitCtx("/nonexistent-lead-history-dir"),
      )
      expect(reported).toEqual(["git"])
      expect(briefing.text).not.toContain(GIT_HEADING)
      expect(briefing.text).toContain(DOCS_HEADING)
    }),
  )

  it.effect("has no git block for a task without a worktree", () =>
    Effect.gen(function* () {
      const briefing = yield* build(codeTask("Fix src/a.ts"), { tank: files({}) })
      expect(briefing.text).not.toContain(GIT_HEADING)
    }),
  )
})
