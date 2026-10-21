import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import { rulesBlock } from "../../src/context/blocks.js"
import { DEFAULT_CONTEXT_CONFIG } from "../../src/context/config.js"
import { MARKER } from "../../src/context/instructions-file.js"
import {
  collectRules,
  isAbsent,
  RULE_SOURCES,
  type RuleSection,
  readRuleItems,
  selectRules,
} from "../../src/context/rules.js"
import { globMatch, splitSections } from "../../src/context/rules-markdown.js"
import { estimateTokens } from "../../src/context/tokens.js"
import { REPO_FILES } from "../fixtures/rules/repo.js"
import { absent } from "./briefing-support.js"
import { bot } from "./fixtures.js"

const ROOT = mkdtempSync(join(tmpdir(), "rules-test-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const ctx: TankContext = { botId: bot.id, botName: bot.name, cwd: ROOT, home: "/home", env: {} }

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

// Replaces the worktree with the given files (and symlinks) and returns a Tank that reads them from it.
const repoTank = (
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): Pick<TankShape, "readFile"> => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ROOT, rel)), { recursive: true })
    writeFileSync(join(ROOT, rel), text)
  }
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(dirname(join(ROOT, rel)), { recursive: true })
    symlinkSync(target, join(ROOT, rel))
  }
  return {
    readFile: (c, rel) =>
      Effect.try({
        try: () => readFileSync(join(c.cwd, rel), "utf8"),
        catch: (cause) => (isMissing(cause) ? absent() : new TankError({ op: "readFile", cause })),
      }),
  }
}

const headings = (sections: ReadonlyArray<RuleSection>) => sections.map((section) => section.heading)

describe("splitSections", () => {
  it("splits at headings of levels 1 to 3, ignores text before the first one and headings inside fences", () => {
    const sections = splitSections(
      "Intro\n# Testing\nRun it.\n## Code style\n```\n# not a heading\n```\n# Deployment\nNever.",
    )
    expect(sections.map((s) => s.heading)).toEqual(["Testing", "Code style", "Deployment"])
    expect(sections[1]?.body).toContain("# not a heading")
  })

  it("a level-4 line is body text, not a section", () => {
    expect(splitSections("# One\n#### deep\ntext").map((s) => s.heading)).toEqual(["One"])
  })

  it("a backtick line whose info string holds a backtick is not a fence (CommonMark)", () => {
    expect(splitSections("# One\n``` a`b `\n# Two\ntext").map((s) => s.heading)).toEqual(["One", "Two"])
  })

  it("a fence closes only with the same character and at least the same length", () => {
    const four = splitSections("# One\n````\n```\n# inside\n~~~~\n````\n# Two").map((s) => s.heading)
    expect(four).toEqual(["One", "Two"])
    const tilde = splitSections("# One\n~~~\n# inside\n```\n# still inside\n~~~\n# Two").map((s) => s.heading)
    expect(tilde).toEqual(["One", "Two"])
  })

  it("an unclosed fence swallows the rest of the file", () => {
    expect(splitSections("# One\n```\n# inside\n# also inside").map((s) => s.heading)).toEqual(["One"])
  })

  it("reads setext headings, with the text line left out of the previous section body", () => {
    const sections = splitSections("# One\nbody one\nSecond\n======\nbody two\nThird\n------\nbody three")
    expect(sections.map((s) => s.heading)).toEqual(["One", "Second", "Third"])
    expect(sections[0]?.body).toBe("body one")
    expect(sections[1]?.body).toBe("body two")
  })

  it("a rule after a blank line or an ATX heading is a break, not a setext underline", () => {
    expect(splitSections("# One\ntext\n\n---\nmore").map((s) => s.heading)).toEqual(["One"])
    expect(splitSections("# One\n---\nmore").map((s) => s.heading)).toEqual(["One"])
  })

  it("a hash without a space is no heading", () => {
    expect(splitSections("# One\n#hashtag\n####### seven").map((s) => s.heading)).toEqual(["One"])
  })
})

describe("globMatch", () => {
  it("matches stars that stop at a slash and double stars that cross them", () => {
    expect(globMatch("src/db/**", "src/db/x.ts")).toBe(true)
    expect(globMatch("src/db/**", "src/db/deep/x.ts")).toBe(true)
    expect(globMatch("src/db/**", "src/dbx/y.ts")).toBe(false)
    expect(globMatch("*.mdc", "a/b.mdc")).toBe(false)
    expect(globMatch("**/*.md", "a.md")).toBe(true)
    expect(globMatch("src/?.ts", "src/a.ts")).toBe(true)
  })
})

describe("collectRules", () => {
  it.effect("reads the rules files in precedence order, with the frontmatter globs on their sections", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(repoTank(REPO_FILES), ctx)
      expect(rules.map((rule) => rule.source)).toEqual([
        ".claude/rules/db.md",
        ...Array(8).fill("CLAUDE.md"),
        ".cursorrules",
      ])
      expect(rules[0]?.paths).toEqual(["src/db/**"])
      expect(rules[1]?.paths).toBeUndefined()
      expect(RULE_SOURCES.length).toBe(7)
    }),
  )

  it.effect("the CONTRIBUTING sections kept are the ones about conventions, style, testing or commits", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(
        repoTank({
          "CONTRIBUTING.md": "# Setup\nInstall it.\n# Commit messages\nUse English.\n# History\nOld.",
        }),
        ctx,
      )
      expect(headings(rules)).toEqual(["Commit messages"])
    }),
  )

  it.effect(
    "a directory entry the indexer skips is not read: a secret-named file, a nested one, the wrong suffix",
    () =>
      Effect.gen(function* () {
        const rules = yield* collectRules(
          repoTank({
            ".claude/rules/.env.md": "# Testing\nkey here",
            ".claude/rules/nested/a.md": "# Testing\nnested",
            ".claude/rules/notes.txt": "# Testing\nwrong suffix",
            ".claude/rules/db.md": "# Testing\nkeep",
          }),
          ctx,
        )
        expect(rules.map((rule) => rule.source)).toEqual([".claude/rules/db.md"])
      }),
  )

  it.effect("a symlink in a rules directory is not read, whatever it points to", () =>
    Effect.gen(function* () {
      const tank = repoTank(
        { ".claude/rules/db.md": "# Testing\nkeep" },
        { ".claude/rules/link.md": "db.md" },
      )
      const rules = yield* collectRules(tank, ctx)
      expect(rules.map((rule) => rule.source)).toEqual([".claude/rules/db.md"])
    }),
  )

  it.effect("a file with a secret-looking token is skipped whole, as the indexer skips it", () =>
    Effect.gen(function* () {
      const token = `gh${"p_"}${"a".repeat(36)}`
      const rules = yield* collectRules(repoTank({ "AGENTS.md": `# Testing\nuse ${token}` }), ctx)
      expect(rules).toEqual([])
    }),
  )

  it.effect("skips the files this module generated", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(
        repoTank({ "AGENTS.md": `${MARKER}\n# Testing\nbody`, "CLAUDE.md": "@AGENTS.md\n" }),
        ctx,
      )
      expect(rules).toEqual([])
    }),
  )

  it.effect("AGENTS.generated.md is never read", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(repoTank({ "AGENTS.generated.md": "# Testing\nbody" }), ctx)
      expect(rules).toEqual([])
    }),
  )

  it.effect("a missing rules file counts as no rules; another read failure fails the effect", () =>
    Effect.gen(function* () {
      const denied = new TankError({
        op: "readFile",
        cause: Object.assign(new Error("no"), { code: "EACCES" }),
      })
      const failed = yield* Effect.flip(collectRules({ readFile: () => Effect.fail(denied) }, ctx))
      expect(failed).toBe(denied)
      expect(isAbsent(absent())).toBe(true)
      expect(isAbsent(new TankError({ op: "readFile", cause: "cat: x: No such file or directory" }))).toBe(
        true,
      )
      expect(isAbsent(denied)).toBe(false)
    }),
  )
})

describe("selectRules", () => {
  it.effect("a task on src/db selects the universal rule, the path rule and one lexical rule", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(repoTank(REPO_FILES), ctx)
      const selected = selectRules(rules, {
        text: "Parameterize the database queries",
        activeFiles: ["src/db/x.ts"],
        kind: "task",
      })
      expect(headings(selected)).toEqual(["Always", "Database", "Parameterize queries"])
    }),
  )

  it.effect("a docs task selects the universal rule and one lexical rule, never the path rule", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(repoTank(REPO_FILES), ctx)
      const selected = selectRules(rules, {
        text: "Update the deployment notes",
        activeFiles: [],
        kind: "task",
      })
      expect(headings(selected)).toEqual(["Always", "Deployment"])
    }),
  )

  it.effect("a path rule does not apply when no active file matches its globs", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(repoTank(REPO_FILES), ctx)
      const selected = selectRules(rules, {
        text: "Poem about birds",
        activeFiles: ["src/ui/a.ts"],
        kind: "task",
      })
      expect(headings(selected)).toEqual(["Always"])
    }),
  )

  it.effect("an invalid frontmatter is reported and its sections stay as unscoped rules", () =>
    Effect.gen(function* () {
      const rules = yield* collectRules(
        repoTank({ ".claude/rules/db.md": "---\npaths: [\n---\n# Database\nUse the query builder." }),
        ctx,
      )
      expect(rules[0]?.paths).toBeUndefined()
      const selected = selectRules(rules, { text: "database query", activeFiles: [], kind: "task" })
      expect(headings(selected)).toEqual(["Database"])
    }),
  )

  it.effect("the items of the block are the selected sections, fenced as data and redacted", () =>
    Effect.gen(function* () {
      const items = yield* readRuleItems(
        repoTank({ "CLAUDE.md": "# Testing\nuse token: abc123secret\nrun tests" }),
        ctx,
        {
          text: "add tests",
          activeFiles: [],
          kind: "code",
        },
      )
      expect(items).toHaveLength(1)
      expect(items[0]?.text).not.toContain("abc123secret")
      expect(items[0]?.text).toContain("run tests")
      expect(items[0]?.text.startsWith("## CLAUDE.md: Testing\n```\n")).toBe(true)
    }),
  )

  it.effect("a heading with a credential is redacted and a huge heading is capped", () =>
    Effect.gen(function* () {
      const secret = yield* readRuleItems(
        repoTank({ ".cursorrules": "# Testing token: abc123secret\nbody" }),
        ctx,
        {
          text: "tests",
          activeFiles: [],
          kind: "code",
        },
      )
      expect(secret[0]?.text).not.toContain("abc123secret")
      expect(secret[0]?.text.startsWith("## .cursorrules: [redacted]\n")).toBe(true)
      const huge = yield* readRuleItems(
        repoTank({ "AGENTS.md": `# Testing ${"x".repeat(5000)}\nbody` }),
        ctx,
        {
          text: "tests",
          activeFiles: [],
          kind: "code",
        },
      )
      const first = (huge[0]?.text ?? "").split("\n")[0] ?? ""
      expect(first.length).toBeLessThanOrEqual("## AGENTS.md: ".length + 80)
    }),
  )

  it.effect("the rules block keeps to its cap: the best items stay, the rest is cut", () =>
    Effect.gen(function* () {
      const big = Array.from({ length: 30 }, (_, i) => `## Testing ${i}\n${"tests and rules ".repeat(40)}`)
      const items = yield* readRuleItems(repoTank({ "CLAUDE.md": big.join("\n") }), ctx, {
        text: "tests and rules",
        activeFiles: [],
        kind: "code",
      })
      expect(items.length).toBeGreaterThan(0)
      const block = rulesBlock(items, DEFAULT_CONTEXT_CONFIG)
      expect(block.items.length).toBeLessThan(items.length)
      const kept = block.items.map((item) => item.text).join("\n")
      expect(estimateTokens(kept)).toBeLessThanOrEqual(DEFAULT_CONTEXT_CONFIG.blocks.rules)
    }),
  )
})

describe("hostile input of 200 KB (linear work, no clock assertion)", () => {
  const SIZE = 200 * 1024

  it.effect("a line of spaces after an ATX marker and a line of hashes complete", () =>
    Effect.gen(function* () {
      const spaces = `# Testing${" ".repeat(SIZE)}x`
      const hashes = `#${"#".repeat(SIZE)}`
      const sections = splitSections(`${spaces}\nbody\n${hashes}\nmore`)
      expect(sections).toHaveLength(1)
      expect(sections[0]?.heading.startsWith("Testing")).toBe(true)
      const items = yield* readRuleItems(repoTank({ "CLAUDE.md": `${spaces}\nbody` }), ctx, {
        text: "testing",
        activeFiles: [],
        kind: "code",
      })
      expect(items.every((item) => item.text.length < 2000)).toBe(true)
    }),
  )

  it.effect("a frontmatter that never closes, and a glob-heavy one, are read as text and bounded", () =>
    Effect.gen(function* () {
      const open = `---\npaths: ["${"a".repeat(SIZE)}"]\n# Testing\nbody`
      const globs = `---\npaths: ["${"*a".repeat(50)}*b"]\n---\n# Testing\nbody`
      const rules = yield* collectRules(repoTank({ "AGENTS.md": open, "CLAUDE.md": globs }), ctx)
      expect(rules.length).toBeGreaterThan(0)
      expect(globMatch(`${"*a".repeat(50)}*b`, "a".repeat(200))).toBe(false)
      const items = yield* readRuleItems(repoTank({ "CLAUDE.md": globs }), ctx, {
        text: "a".repeat(SIZE),
        activeFiles: ["x".repeat(SIZE)],
        kind: "code",
      })
      expect(items.length).toBeLessThanOrEqual(1)
    }),
  )

  it.effect(
    "a file at the size limit with many headings and a long lexical query is scored once per rule",
    () =>
      Effect.gen(function* () {
        const manyHeadings = Array.from({ length: 2000 }, (_, i) => `# Rule ${i}\nbody word${i} test`).join(
          "\n",
        )
        const items = yield* readRuleItems(repoTank({ "CLAUDE.md": manyHeadings.slice(0, SIZE) }), ctx, {
          text: Array.from({ length: 800 }, (_, i) => `word${i}`).join(" "),
          activeFiles: [],
          kind: "code",
        })
        expect(items.length).toBeGreaterThan(0)
      }),
  )
})
