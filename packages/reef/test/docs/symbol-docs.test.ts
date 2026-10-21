import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { identifiersIn, MAX_DOC_SYMBOLS, markdownSymbols, taskSymbols } from "../../src/docs/doc-symbols.js"
import { DOC_EXCERPT_MAX, docsForSymbols } from "../../src/docs/symbol-docs.js"
import { Indexer } from "../../src/indexer/indexer.js"
import { indexerEnv, withFixtureRepo } from "../indexer/helpers.js"

const GIT_MD = [
  "# Git intel",
  "",
  "## `recentChanges`",
  "",
  "Lists the commits of the last days that touched a path. Use it before editing.",
  "",
  "## Other",
  "",
  "Nothing about the symbol here.",
  "",
].join("\n")

// A chunk row as the indexer stores it; the symbols come from the same function the indexer uses for markdown.
const insertChunk = (
  id: string,
  path: string,
  lang: string,
  content: string,
  symbols: ReadonlyArray<string>,
  startLine = 1,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at)
      VALUES (${id}, 'acme/demo', ${path}, ${startLine}, ${startLine + 9}, ${id}, ${lang}, ${JSON.stringify(symbols)},
        ${content}, '2026-10-20T00:00:00.000Z')`
  })

describe("markdownSymbols and taskSymbols", () => {
  it("names the words of headings and the identifiers in backticks", () => {
    const symbols = markdownSymbols(["## `recentChanges` and `Foo.bar()`", "plain text `not a name` `1bad`"])
    expect(symbols).toEqual(expect.arrayContaining(["recentChanges", "Foo", "bar"]))
    expect(symbols).not.toContain("not")
    expect(symbols).not.toContain("1bad")
    expect(identifiersIn("Foo.bar()")).toEqual(["Foo", "bar"])
  })

  it("takes the task's backticked names and the exported declarations of its files only", () => {
    const symbols = taskSymbols("Change `alpha` and `beta()` please.", [
      {
        path: "src/app.ts",
        content: "export function gamma(x: number) {}\nfunction hidden() {}\nexport const delta = 1\n",
      },
    ])
    expect(symbols).toEqual(["alpha", "beta", "gamma", "delta"])
  })

  it("stays bounded on 200 KB of hostile markdown", () => {
    const backticks = Array.from({ length: 100 }, () => "`".repeat(1999))
    const oneLine = ["# ", "`a".repeat(50_000)].join("")
    const symbols = markdownSymbols([...backticks, oneLine, "x".repeat(100_000)])
    expect(symbols.length).toBeLessThanOrEqual(MAX_DOC_SYMBOLS)
    const tokens = taskSymbols("`b` ".repeat(40_000), [])
    expect(tokens).toEqual(["b"])
  })
})

describe("docsForSymbols", () => {
  it.effect("finds the heading that names the symbol and returns its excerpt", () =>
    Effect.gen(function* () {
      const content = "## Como usar\n\nChame `recentChanges` com o caminho.\n\n## Outro\nnada"
      yield* insertChunk("c1", "docs/git.md", "md", content, markdownSymbols(content.split("\n")))
      const [hit, ...rest] = yield* docsForSymbols("acme/demo", ["recentChanges"])
      expect(rest).toEqual([])
      expect(hit?.path).toBe("docs/git.md")
      expect(hit?.heading).toBe("Como usar")
      expect(hit?.excerpt.startsWith("Chame `recentChanges`")).toBe(true)
      expect(hit?.excerpt.length).toBeLessThanOrEqual(DOC_EXCERPT_MAX)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("ignores markdown without the symbol and chunks of other languages", () =>
    Effect.gen(function* () {
      yield* insertChunk("c1", "docs/other.md", "md", "## Unrelated\nno names here", ["Unrelated"])
      yield* insertChunk("c2", "src/x.ts", "ts", "// recentChanges\n", ["recentChanges"])
      expect(yield* docsForSymbols("acme/demo", ["recentChanges"])).toEqual([])
      expect(yield* docsForSymbols("other/repo", ["Unrelated"])).toEqual([])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("returns at most three excerpts per symbol, in path order", () =>
    Effect.gen(function* () {
      for (const index of [1, 2, 3, 4]) {
        yield* insertChunk(`m${index}`, `docs/p${index}.md`, "md", `Use \`alpha\` (${index}).`, ["alpha"])
      }
      const hits = yield* docsForSymbols("acme/demo", ["alpha"])
      expect(hits.map((hit) => hit.path)).toEqual(["docs/p1.md", "docs/p2.md", "docs/p3.md"])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("leaves out an excerpt that looks like a secret", () =>
    Effect.gen(function* () {
      const token = ["sk", "ant", "b".repeat(24)].join("-")
      yield* insertChunk("s1", "docs/a-secret.md", "md", `Key \`alpha\` is ${token}`, ["alpha"])
      yield* insertChunk("s2", "docs/b-clean.md", "md", "Use `alpha` safely.", ["alpha"])
      const hits = yield* docsForSymbols("acme/demo", ["alpha"])
      expect(hits.map((hit) => hit.path)).toEqual(["docs/b-clean.md"])
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("markdown symbols in the index", () => {
  it.effect("indexes the symbols of markdown and refreshes rows stored before they existed", () =>
    withFixtureRepo(
      (repo) =>
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const sql = yield* SqlClient
          yield* indexer.index(repo.dir, { repo: "acme/demo" })
          const first = yield* indexer.docs("acme/demo", ["recentChanges", "ghost"])
          expect(first.map((hit) => hit.path)).toEqual(["docs/git.md"])
          expect(first[0]?.excerpt.startsWith("## `recentChanges`")).toBe(true)
          yield* sql`UPDATE code_chunks SET symbols = '[]' WHERE lang = 'md'`
          expect(yield* indexer.docs("acme/demo", ["recentChanges"])).toEqual([])
          yield* indexer.index(repo.dir, { repo: "acme/demo" })
          expect(yield* indexer.docs("acme/demo", ["recentChanges"])).toHaveLength(1)
        }),
      { "docs/git.md": GIT_MD },
    ).pipe(Effect.provide(indexerEnv())),
  )
})
